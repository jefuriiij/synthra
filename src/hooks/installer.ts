// Writes hook scripts into <project>/.claude/hooks/ and registers them in
// <project>/.claude/settings.local.json. Idempotent — re-running `syn .`
// regenerates the scripts and merges hook entries cleanly with any user-added
// hooks already in the file.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";

import preCompactPs1 from "./scripts/pre-compact.ps1";
import preCompactSh from "./scripts/pre-compact.sh";
import preToolUsePs1 from "./scripts/pre-tool-use.ps1";
import preToolUseSh from "./scripts/pre-tool-use.sh";
import primePs1 from "./scripts/prime.ps1";
import primeSh from "./scripts/prime.sh";
import stopPs1 from "./scripts/stop.ps1";
import stopSh from "./scripts/stop.sh";

export interface InstallResult {
  scriptsWritten: string[];
  settingsUpdated: boolean;
}

interface ScriptDef {
  /** Hook event name as recognized by Claude Code. */
  event: "SessionStart" | "PreToolUse" | "PreCompact" | "Stop";
  /** Tool-name regex for PreToolUse only. */
  matcher?: string;
  /** Base filename written into .claude/hooks/. */
  baseName: string;
  ps1: string;
  sh: string;
}

const SCRIPTS: ScriptDef[] = [
  { event: "SessionStart", baseName: "synthra-prime", ps1: primePs1, sh: primeSh },
  { event: "PreToolUse", matcher: "Grep|Glob", baseName: "synthra-pre-tool-use", ps1: preToolUsePs1, sh: preToolUseSh },
  { event: "PreCompact", baseName: "synthra-pre-compact", ps1: preCompactPs1, sh: preCompactSh },
  { event: "Stop", baseName: "synthra-stop", ps1: stopPs1, sh: stopSh },
];

const SYNTHRA_HOOK_MARKER = "synthra-hook=true";

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

interface HooksConfig {
  hooks?: {
    [event: string]: Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; meta?: string }>;
    }>;
  };
  [k: string]: unknown;
}

async function readSettings(path: string): Promise<HooksConfig> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as HooksConfig;
  } catch {
    return {};
  }
}

function stripOurHooks(config: HooksConfig): HooksConfig {
  if (!config.hooks) return config;
  const next: HooksConfig["hooks"] = {};
  for (const [event, entries] of Object.entries(config.hooks)) {
    const filtered = entries
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((h) => h.meta !== SYNTHRA_HOOK_MARKER),
      }))
      .filter((entry) => (entry.hooks?.length ?? 0) > 0);
    if (filtered.length) next[event] = filtered;
  }
  config.hooks = next;
  return config;
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
    await writeFile(target, chosenScriptBody(s), "utf8");
    scriptsWritten.push(target);
  }

  await mkdir(dirname(paths.claudeSettings), { recursive: true });
  const existing = await readSettings(paths.claudeSettings);
  const stripped = stripOurHooks(existing);
  const merged = mergeOurHooks(stripped, paths);

  await writeFile(paths.claudeSettings, JSON.stringify(merged, null, 2) + "\n", "utf8");

  log.debug(`installed ${scriptsWritten.length} hook script(s) into ${paths.claudeHooksDir}`);

  return { scriptsWritten, settingsUpdated: true };
}
