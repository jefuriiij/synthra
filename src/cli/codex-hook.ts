// `syn hook <event>`: Synthra's hooks for Codex (v0.42). `syn codex` puts them
// in Codex's global hooks file; Codex runs them in the session's folder with
// the event as JSON on stdin, the same shape Claude Code sends. Each one finds
// the project from that folder (like `syn mcp`) and calls the routes Claude's
// hook scripts call:
//
//   session-start  GET /prime: memory, the resume digest. Codex adds plain or
//                  JSON `additionalContext` output as developer context. Also
//                  runs after a compaction (source "compact").
//   pre-tool-use   POST /gate for shell commands. Codex has no Grep or Glob
//                  tool, and the gate only watches shell commands, so this
//                  records searches and never blocks one.
//   stop           tokens for the turn from Codex's session file, then
//                  /context-update and the memory and skill reminders
//                  (/nudge). Codex continues the turn on {"decision":"block"}.
//
// The command text stays the same across Synthra versions: Codex asks the user
// to trust a hook again whenever its command changes.
//
// Every failure is silent (exit 0, no output): a hook must never break Codex.
// Calls carry the via header, so the server keeps Codex apart from Claude.

import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import { readJsonFile, updateJsonFile } from "../shared/json-store.js";
import { resolvePaths } from "../shared/paths.js";
import { findProjectRoot, liveServer, VIA_HEADER } from "./project-root.js";

export const CODEX_HOOK_EVENTS = {
  SessionStart: "session-start",
  PreToolUse: "pre-tool-use",
  Stop: "stop",
} as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[keyof typeof CODEX_HOOK_EVENTS];

const CALL_TIMEOUT_MS = 3000;
/** Sessions whose read position is kept; older ones drop off. */
const KEEP_SESSIONS = 50;
/** The most of a session file one Stop reads (a first look at a long session). */
const MAX_READ_BYTES = 32 * 1024 * 1024;

interface HookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  model?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  stop_hook_active?: unknown;
}

async function call(port: number, path: string, body?: unknown): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", [VIA_HEADER]: "codex" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** One hook run: the JSON Codex sent, in; what to print, out (null: nothing). */
export async function runCodexHook(
  event: string,
  stdin: string,
  fallbackCwd = process.cwd(),
): Promise<string | null> {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const root = await findProjectRoot(typeof input.cwd === "string" ? input.cwd : fallbackCwd);
  if (!root) return null;
  const server = await liveServer(root);
  if (!server) return null;

  switch (event) {
    case CODEX_HOOK_EVENTS.SessionStart:
      return sessionStart(server.port);
    case CODEX_HOOK_EVENTS.PreToolUse:
      return preToolUse(server.port, input);
    case CODEX_HOOK_EVENTS.Stop:
      return stop(server.port, root, input);
    default:
      return null;
  }
}

async function sessionStart(port: number): Promise<string | null> {
  const res = (await call(port, "/prime")) as { primer?: unknown } | null;
  if (typeof res?.primer !== "string" || !res.primer.trim()) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: res.primer },
  });
}

async function preToolUse(port: number, input: HookInput): Promise<string | null> {
  if (typeof input.tool_name !== "string") return null;
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? { ...(input.tool_input as Record<string, unknown>) }
      : {};
  // A shell command can arrive as an argument list.
  if (Array.isArray(toolInput.command)) toolInput.command = toolInput.command.join(" ");
  const res = (await call(port, "/gate", {
    tool_name: input.tool_name,
    tool_input: toolInput,
    session_id: input.session_id,
  })) as { decision?: unknown; reason?: unknown } | null;
  if (res?.decision !== "block") return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: String(res.reason ?? "Synthra's map answers this."),
    },
  });
}

/** Codex's running totals for a session, from its `token_count` events. */
export interface CodexTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

interface SessionMark {
  /** Bytes of the session file already read. */
  offset: number;
  totals: CodexTotals;
  at: string;
}

type Marks = Record<string, SessionMark>;

const ZERO: CodexTotals = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

/** What one stretch of Codex's session file says: the newest running token
 *  totals, the newest rate limits, and how many tools were called. The format
 *  isn't a stable interface (Codex's docs say so), so anything unexpected is
 *  skipped. */
export function readCodexTurn(text: string): {
  totals: CodexTotals | null;
  toolCalls: number;
  limits: { fiveHour?: number; week?: number } | null;
} {
  let totals: CodexTotals | null = null;
  let limits: { fiveHour?: number; week?: number } | null = null;
  let toolCalls = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: unknown; payload?: Record<string, unknown> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = e?.payload;
    if (!p || typeof p !== "object") continue;
    if (e.type === "response_item" && typeof p.type === "string" && p.type.endsWith("_call")) {
      toolCalls++;
    }
    if (e.type !== "event_msg" || p.type !== "token_count") continue;
    const info = p.info as { total_token_usage?: Record<string, unknown> } | null | undefined;
    const t = info?.total_token_usage;
    if (t && typeof t.input_tokens === "number" && typeof t.output_tokens === "number") {
      const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
      totals = {
        input: n(t.input_tokens),
        cached: n(t.cached_input_tokens),
        cacheWrite: n(t.cache_write_input_tokens),
        output: n(t.output_tokens),
      };
    }
    const r = p.rate_limits as
      | { primary?: { used_percent?: unknown }; secondary?: { used_percent?: unknown } }
      | undefined;
    if (r) {
      const pct = (v: unknown) => (typeof v === "number" ? v : undefined);
      limits = {
        ...(pct(r.primary?.used_percent) !== undefined
          ? { fiveHour: pct(r.primary?.used_percent) }
          : {}),
        ...(pct(r.secondary?.used_percent) !== undefined
          ? { week: pct(r.secondary?.used_percent) }
          : {}),
      };
    }
  }
  return { totals, toolCalls, limits };
}

/** The bytes after `offset`, up to the last full line. */
async function readNew(file: string, offset: number): Promise<{ text: string; end: number }> {
  const size = (await stat(file)).size;
  const from = offset <= size ? offset : 0;
  const length = Math.min(size - from, MAX_READ_BYTES);
  if (length <= 0) return { text: "", end: from };
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, from);
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return { text: "", end: from };
    return { text: buf.subarray(0, last + 1).toString("utf8"), end: from + last + 1 };
  } finally {
    await fh.close();
  }
}

async function stop(port: number, root: string, input: HookInput): Promise<string | null> {
  const session = typeof input.session_id === "string" ? input.session_id : null;
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : null;
  let toolCalls = 0;

  if (session && transcript) {
    const marksFile = join(resolvePaths(root).graphDir, "codex_sessions.json");
    const read = await readJsonFile<Marks>(marksFile);
    const marks =
      read.status === "ok" && read.data && typeof read.data === "object" ? read.data : {};
    const before = marks[session];
    const turn = await readNew(transcript, before?.offset ?? 0).catch(() => null);
    if (turn && turn.end !== (before?.offset ?? 0)) {
      const seen = readCodexTurn(turn.text);
      toolCalls = seen.toolCalls;
      const prev = before?.totals ?? ZERO;
      const now = seen.totals ?? prev;
      const d = (k: keyof CodexTotals) => Math.max(0, now[k] - prev[k]);
      const cached = d("cached");
      const used = {
        // Claude's convention, which the dashboard reads: input without cache hits.
        input_tokens: Math.max(0, d("input") - cached),
        output_tokens: d("output"),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: d("cacheWrite"),
      };
      // Only the first Stop to get here records this stretch.
      const claimed = await updateJsonFile<Marks>(
        marksFile,
        () => ({}),
        (current) => {
          if ((current[session]?.offset ?? 0) !== (before?.offset ?? 0)) return null;
          const next: Marks = {
            ...current,
            [session]: { offset: turn.end, totals: now, at: new Date().toISOString() },
          };
          const ids = Object.keys(next).sort((a, b) =>
            (next[b]?.at ?? "").localeCompare(next[a]?.at ?? ""),
          );
          for (const id of ids.slice(KEEP_SESSIONS)) delete next[id];
          return next;
        },
      ).catch(() => null);
      if (claimed?.status === "written" && (used.input_tokens > 0 || used.output_tokens > 0)) {
        await call(port, "/log", {
          ...used,
          model: typeof input.model === "string" ? input.model : "",
          description: "synthra-codex-stop-hook",
          project: root,
          agent: "codex",
          session_id: session,
          tool_calls: toolCalls,
          ...(seen.limits ? { codex_limits: seen.limits } : {}),
        });
      }
    }
  }

  await call(port, "/context-update", {});
  const nudge = (await call(port, "/nudge", {
    stop_hook_active: input.stop_hook_active === true,
    tool_calls: toolCalls,
  })) as { reason?: unknown } | null;
  if (typeof nudge?.reason === "string" && nudge.reason) {
    return JSON.stringify({ decision: "block", reason: nudge.reason });
  }
  return null;
}

/** The CLI entry: Codex pipes the event in and reads what is printed. */
export async function codexHookCommand(event: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const out = await runCodexHook(event, Buffer.concat(chunks).toString("utf8")).catch(() => null);
  if (out) process.stdout.write(`${out}\n`);
}
