// Writes hook scripts into <project>/.claude/hooks/ and registers them in
// <project>/.claude/settings.local.json. Idempotent — re-running `syn .`
// regenerates the scripts and merges hook entries cleanly with any user-added
// hooks already in the file.

import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { updateJsonFile, writeTextAtomic } from "../shared/json-store.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import { SYNTHRA_HOOK_MARKER, stripOurHooks, type HooksConfig } from "./hooks-config.js";

import preCompactPs1 from "./scripts/pre-compact.ps1";
import preCompactSh from "./scripts/pre-compact.sh";
import preToolUsePs1 from "./scripts/pre-tool-use.ps1";
import preToolUseSh from "./scripts/pre-tool-use.sh";
import primePs1 from "./scripts/prime.ps1";
import primeSh from "./scripts/prime.sh";
import routePs1 from "./scripts/route.ps1";
import routeSh from "./scripts/route.sh";
import stopPs1 from "./scripts/stop.ps1";
import stopSh from "./scripts/stop.sh";

export interface InstallResult {
  scriptsWritten: string[];
  settingsUpdated: boolean;
  /** Set when settings.local.json existed but couldn't be parsed, so we refused
   *  to touch it. The hook scripts are on disk but nothing is registered. */
  settingsUnreadable?: string;
}

interface ScriptDef {
  /** Hook event name as recognized by Claude Code. */
  event: "SessionStart" | "PreToolUse" | "PreCompact" | "Stop" | "UserPromptSubmit";
  /** Tool-name regex for PreToolUse only. */
  matcher?: string;
  /** Base filename written into .claude/hooks/. */
  baseName: string;
  ps1: string;
  sh: string;
}

const SCRIPTS: ScriptDef[] = [
  { event: "SessionStart", baseName: "synthra-prime", ps1: primePs1, sh: primeSh },
  {
    event: "PreToolUse",
    // Grep/Glob are gated (blockable); Bash is observe-only (the terminal
    // bypass — see src/server/routes/bash-observe.ts). The shared hook forwards
    // the tool call to /gate, which decides per-tool.
    matcher: "Grep|Glob|Bash",
    baseName: "synthra-pre-tool-use",
    ps1: preToolUsePs1,
    sh: preToolUseSh,
  },
  { event: "PreCompact", baseName: "synthra-pre-compact", ps1: preCompactPs1, sh: preCompactSh },
  { event: "Stop", baseName: "synthra-stop", ps1: stopPs1, sh: stopSh },
  // The Dispatcher — per-prompt routing hint (best-fit agent/skill/model).
  { event: "UserPromptSubmit", baseName: "synthra-route", ps1: routePs1, sh: routeSh },
];

function commandFor(scriptPath: string): string {
  if (process.platform === "win32") {
    // PowerShell on Windows; -ExecutionPolicy Bypass so the script always runs.
    return `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${scriptPath}"`;
  }
  return `bash "${scriptPath}"`;
}

/** Force the line endings the interpreter needs: CRLF for PowerShell, LF for
 *  bash. Never trust the inlined body — esbuild embeds whatever bytes sat on the
 *  build machine's disk, and `.gitattributes`' `text=auto` makes a CRLF
 *  working-tree file hash identical to its LF blob — so it never shows as a
 *  content diff, can never be committed, and no source-level check or CI job can
 *  see it. Only the build machine's disk is poisoned. That shipped a CRLF
 *  `pre-tool-use.sh` in 0.27.0: bash dies at parse time (`$'\r': command not
 *  found`), and because that hook matches `Grep|Glob|Bash`, it takes all three
 *  tools out of the session — including the ones needed to repair it, so the
 *  agent can't self-heal. Normalizing here is the only defense that holds
 *  regardless of build-machine state, and it repairs a poisoned install on the
 *  next `syn .`. See issue #2. */
export function normalizeEol(body: string, ext: string): string {
  return ext === ".ps1" ? body.replace(/\r?\n/g, "\r\n") : body.replace(/\r\n/g, "\n");
}

function chosenScriptBody(s: ScriptDef): string {
  return process.platform === "win32" ? normalizeEol(s.ps1, ".ps1") : normalizeEol(s.sh, ".sh");
}

function chosenScriptExt(): string {
  return process.platform === "win32" ? ".ps1" : ".sh";
}

function mergeOurHooks(config: HooksConfig, paths: SynthraPaths): HooksConfig {
  const hooks = (config.hooks = config.hooks ?? {});
  for (const s of SCRIPTS) {
    const scriptPath = join(paths.claudeHooksDir, `${s.baseName}${chosenScriptExt()}`);
    const entry = {
      ...(s.matcher ? { matcher: s.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: commandFor(scriptPath),
          meta: SYNTHRA_HOOK_MARKER,
        },
      ],
    };
    const list = (hooks[s.event] = hooks[s.event] ?? []);
    list.push(entry);
  }
  return config;
}

export async function installHooks(paths: SynthraPaths): Promise<InstallResult> {
  await mkdir(paths.claudeHooksDir, { recursive: true });

  const scriptsWritten: string[] = [];
  const staleExt = chosenScriptExt() === ".ps1" ? ".sh" : ".ps1";
  for (const s of SCRIPTS) {
    const target = join(paths.claudeHooksDir, `${s.baseName}${chosenScriptExt()}`);
    // Atomic: a half-written hook script is one Claude Code will still try to
    // execute on the next tool call.
    await writeTextAtomic(target, chosenScriptBody(s));
    scriptsWritten.push(target);

    // Drop the other platform's copy. We only ever write chosenScriptExt(), so
    // switching platforms on a shared checkout — or upgrading from a version
    // that wrote both — leaves orphans here that no later run touches and only
    // `syn remove` cleans up. They're never registered, but they read as live
    // hooks to anyone auditing .claude/hooks/.
    await unlink(join(paths.claudeHooksDir, `${s.baseName}${staleExt}`)).catch(() => {});
  }

  await mkdir(dirname(paths.claudeSettings), { recursive: true });

  // Read-merge-write in one verified step. Claude Code owns this file too and
  // rewrites it on every permission approval, so reading it, merging, and
  // writing as separate steps silently discarded any approval granted in the
  // gap. A corrupt file is quarantined and NOT rebuilt: merging our hooks into
  // a blank object would erase every permission and every other tool's hooks.
  const result = await updateJsonFile<HooksConfig>(
    paths.claudeSettings,
    () => ({}), // first run — safe to create
    (current) => mergeOurHooks(stripOurHooks(current), paths),
  );

  if (result.status === "corrupt") {
    log.error(
      `${paths.claudeSettings} could not be parsed (${result.error}) — hooks were NOT registered so your permissions aren't overwritten.` +
        (result.quarantined
          ? ` A copy is at ${result.quarantined}; fix the JSON or restore it, then re-run \`syn .\`.`
          : ""),
    );
    return { scriptsWritten, settingsUpdated: false, settingsUnreadable: result.error };
  }

  log.debug(`installed ${scriptsWritten.length} hook script(s) into ${paths.claudeHooksDir}`);

  return { scriptsWritten, settingsUpdated: true };
}
