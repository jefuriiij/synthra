// Writes hook scripts into <project>/.claude/hooks/ and registers them in
// <project>/.claude/settings.local.json. Idempotent — re-running `syn .`
// regenerates the scripts and merges hook entries cleanly with any user-added
// hooks already in the file.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  quarantineFile,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic,
} from "../shared/json-store.js";
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

function chosenScriptBody(s: ScriptDef): string {
  return process.platform === "win32" ? s.ps1 : s.sh;
}

function chosenScriptExt(): string {
  return process.platform === "win32" ? ".ps1" : ".sh";
}

// NOTE: this used to `catch { return {} }`, and the caller then merged our hooks
// into that empty object and wrote it back — silently discarding every permission
// the user had granted and every non-Synthra hook in the file. settings.local.json
// is user-owned and Claude Code writes it too, so an unreadable one now stops the
// install rather than replacing it.
async function readSettings(path: string): Promise<HooksConfig | { unreadable: string }> {
  const read = await readJsonFile<HooksConfig>(path);
  if (read.status === "ok") return read.data;
  if (read.status === "missing") return {}; // first run — safe to create
  return { unreadable: read.error };
}

function isUnreadable(v: HooksConfig | { unreadable: string }): v is { unreadable: string } {
  return "unreadable" in v && typeof (v as { unreadable: unknown }).unreadable === "string";
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
  for (const s of SCRIPTS) {
    const target = join(paths.claudeHooksDir, `${s.baseName}${chosenScriptExt()}`);
    // Atomic: a half-written hook script is one Claude Code will still try to
    // execute on the next tool call.
    await writeTextAtomic(target, chosenScriptBody(s));
    scriptsWritten.push(target);
  }

  await mkdir(dirname(paths.claudeSettings), { recursive: true });
  const existing = await readSettings(paths.claudeSettings);

  if (isUnreadable(existing)) {
    // Refuse rather than rebuild. The file holds the user's permissions and any
    // hooks other tools installed; merging into a blank object would erase them.
    const moved = await quarantineFile(paths.claudeSettings);
    log.error(
      `${paths.claudeSettings} could not be parsed (${existing.unreadable}) — hooks were NOT registered so your permissions aren't overwritten.` +
        (moved ? ` A copy is at ${moved}; fix the JSON or restore it, then re-run \`syn .\`.` : ""),
    );
    return { scriptsWritten, settingsUpdated: false, settingsUnreadable: existing.unreadable };
  }

  const merged = mergeOurHooks(stripOurHooks(existing), paths);
  await writeJsonAtomic(paths.claudeSettings, merged);

  log.debug(`installed ${scriptsWritten.length} hook script(s) into ${paths.claudeHooksDir}`);

  return { scriptsWritten, settingsUpdated: true };
}
