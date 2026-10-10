// `syn codex`: give Codex Synthra's map tools (v0.41) and hooks (v0.42).
//
// One entry in Codex's global MCP list starts `syn mcp`, which finds the
// project's server from the folder Codex runs in (see mcp-bridge.ts). Three
// hooks in Codex's global hooks file run `syn hook <event>`, which finds the
// project the same way (see codex-hook.ts). So it is set up once per machine,
// not per project. `--remove` takes both out again.

import spawn from "cross-spawn";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readJsonFile, writeJsonAtomic } from "../shared/json-store.js";
import { log } from "../shared/logger.js";
import { CODEX_HOOK_EVENTS } from "./codex-hook.js";

export const CODEX_MCP_NAME = "synthra";
/** What Codex runs: `syn mcp`, through the PATH like `npx` in its own list. */
export const CODEX_MCP_COMMAND = ["syn", "mcp"];

/** Every hook command starts with this; it is how ours are told apart. */
const HOOK_PREFIX = "syn hook ";

interface HookHandler {
  type: "command";
  command: string;
  timeout: number;
  additionalContextLimit?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
interface HooksFile {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/**
 * Synthra's hooks for Codex. Codex asks the user to trust a hook again when it
 * changes, so this stays the same from one Synthra version to the next.
 * Timeouts are seconds. The primer (memory files plus the resume digest) can
 * pass Codex's default limit of about 2,500 tokens per hook message.
 */
export const CODEX_HOOKS: Record<string, HookGroup[]> = {
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: `${HOOK_PREFIX}${CODEX_HOOK_EVENTS.SessionStart}`,
          timeout: 10,
          additionalContextLimit: 6000,
        },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: `${HOOK_PREFIX}${CODEX_HOOK_EVENTS.PreToolUse}`, timeout: 5 },
      ],
    },
  ],
  Stop: [
    {
      hooks: [{ type: "command", command: `${HOOK_PREFIX}${CODEX_HOOK_EVENTS.Stop}`, timeout: 30 }],
    },
  ],
};

function runCodex(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    const proc = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c) => (stderr += String(c)));
    proc.on("error", () => done({ code: -1, stderr: "codex is not on the PATH" }));
    proc.on("exit", (code) => done({ code: code ?? 0, stderr }));
  });
}

function codexHome(env = process.env, home = homedir()): string {
  return env.CODEX_HOME || join(home, ".codex");
}

/** Codex's config file: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
export function codexConfigPath(env = process.env, home = homedir()): string {
  return join(codexHome(env, home), "config.toml");
}

/** Codex's global hooks file, next to its config. */
export function codexHooksPath(env = process.env, home = homedir()): string {
  return join(codexHome(env, home), "hooks.json");
}

/** Whether Codex's config names Synthra's server, and with what command.
 *  A plain text look, not a TOML parser: Codex writes this table itself. */
export async function codexEntry(
  file = codexConfigPath(),
): Promise<{ present: boolean; command?: string } | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const table = text.split(/^\[/m).find((t) => /^mcp_servers\.synthra\]/.test(t));
  if (!table) return { present: false };
  const command = /^command\s*=\s*["']([^"']*)["']/m.exec(table)?.[1];
  return command === undefined ? { present: true } : { present: true, command };
}

const ours = (h: HookHandler) =>
  typeof h?.command === "string" && h.command.startsWith(HOOK_PREFIX);

/** `hooks` with every Synthra handler taken out; groups left empty go too. */
export function withoutOurHooks(hooks: Record<string, HookGroup[]>): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ours(h)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/** `hooks` with Synthra's handlers in their current form. Other hooks stay. */
export function withOurHooks(hooks: Record<string, HookGroup[]>): Record<string, HookGroup[]> {
  const out = withoutOurHooks(hooks);
  for (const [event, groups] of Object.entries(CODEX_HOOKS)) {
    out[event] = [...(out[event] ?? []), ...groups];
  }
  return out;
}

/** Which of Synthra's hook events Codex's hooks file has. Null without a file. */
export async function codexHooksInstalled(file = codexHooksPath()): Promise<string[] | null> {
  const read = await readJsonFile<HooksFile>(file);
  if (read.status !== "ok") return read.status === "missing" ? [] : null;
  const hooks = read.data?.hooks ?? {};
  return Object.keys(CODEX_HOOKS).filter((event) =>
    (hooks[event] ?? []).some((g) => Array.isArray(g?.hooks) && g.hooks.some(ours)),
  );
}

/** Add or remove Synthra's hooks. Refuses to touch a file it can't read. */
async function writeHooks(file: string, add: boolean): Promise<boolean> {
  const read = await readJsonFile<HooksFile>(file);
  if (read.status === "corrupt") {
    log.error(`${file} isn't valid JSON, so Synthra left it alone. Fix it, then run this again.`);
    return false;
  }
  const current: HooksFile = read.status === "ok" && read.data ? read.data : {};
  const hooks = current.hooks && typeof current.hooks === "object" ? current.hooks : {};
  const next = add ? withOurHooks(hooks) : withoutOurHooks(hooks);
  if (!add && read.status === "missing") return true;
  await writeJsonAtomic(file, { ...current, hooks: next }, { pretty: true });
  return true;
}

export async function codexCommand(opts: { remove?: boolean } = {}): Promise<void> {
  // `codex mcp add` replaces an entry of the same name (Codex 0.160).
  const args = opts.remove
    ? ["mcp", "remove", CODEX_MCP_NAME]
    : ["mcp", "add", CODEX_MCP_NAME, "--", ...CODEX_MCP_COMMAND];
  const result = await runCodex(args);
  if (result.code === -1) {
    log.error("Codex isn't installed, or `codex` is not on the PATH.");
    process.exitCode = 1;
    return;
  }
  // Removing an entry that isn't there fails too; that is fine.
  if (result.code !== 0 && !opts.remove) {
    log.error(`codex mcp add failed (code ${result.code}): ${result.stderr.trim()}`);
    process.exitCode = 1;
    return;
  }
  const hooksOk = await writeHooks(codexHooksPath(), !opts.remove);
  if (!hooksOk) process.exitCode = 1;
  if (opts.remove) {
    log.info("Codex no longer starts Synthra. New Codex sessions won't have its tools or hooks.");
    return;
  }
  log.info("Codex now starts Synthra in every project Synthra has mapped:");
  log.info("  - the map tools (they run without asking; tools that write ask you first);");
  if (hooksOk) {
    log.info("  - hooks: memory at session start, token tracking, memory and skill reminders.");
    log.info("Codex asks you to trust new hooks once: open Codex, type /hooks, and trust");
    log.info("Synthra's three hooks. Then start a new Codex session.");
  }
}
