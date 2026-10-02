// When each hook last reached this project's server, in
// .synthra-graph/heartbeat.json. The dashboard's health table reads it.
//
// Every serious Synthra failure so far was silent: a hook that stops talking
// to the server (hooks registered twice, a dead port file, a shell folder
// that moved) leaves no error anywhere. A timestamp per hook turns "nothing
// happened" into something a page can see: the session started an hour ago,
// but no reply has been logged for 18 days.
//
// Written at most every WRITE_EVERY_MS per server, plus the first time each
// hook is seen: the gate fires on every Grep, Glob, Bash and Skill call, and a
// timestamp a few seconds old is as good as an exact one.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { readJsonFile, writeJsonAtomic } from "../shared/json-store.js";

/** start = SessionStart and PreCompact, tools = PreToolUse, reply = Stop,
 *  prompt = UserPromptSubmit. */
export type HookName = "start" | "tools" | "reply" | "prompt";

export interface Heartbeat {
  /** The Synthra version of the server that last wrote the file. */
  version: string;
  /** ISO time each hook last reached the server. */
  hooks: Partial<Record<HookName, string>>;
}

export const WRITE_EVERY_MS = 30_000;

/** By heartbeat path: one entry per server (one project). */
const live = new Map<string, { beat: Heartbeat; writtenAt: number; writing?: Promise<void> }>();

/**
 * Note that a hook reached the server. Never throws and never slows the hook
 * down: the write runs in the background, and a failed one is just retried by
 * the next beat.
 */
export function noteHook(file: string, hook: HookName, version: string, now = Date.now()): void {
  let s = live.get(file);
  if (!s) {
    s = { beat: { version, hooks: {} }, writtenAt: 0 };
    live.set(file, s);
  }
  const first = s.beat.hooks[hook] === undefined;
  s.beat.version = version;
  s.beat.hooks[hook] = new Date(now).toISOString();
  if (s.writing || (!first && now - s.writtenAt < WRITE_EVERY_MS)) return;

  const state = s;
  state.writtenAt = now;
  state.writing = (async () => {
    try {
      // Merge over what is on disk: hooks this process hasn't seen yet (a
      // restart, a second editor window) keep their last time.
      const prev = await readHeartbeat(file);
      await mkdir(dirname(file), { recursive: true });
      await writeJsonAtomic(file, {
        ...state.beat,
        hooks: { ...prev?.hooks, ...state.beat.hooks },
      });
    } catch {
      // best effort: the next beat writes again
    } finally {
      state.writing = undefined;
    }
  })();
}

/** Wait for a background write. Tests, and a server shutting down. */
export async function flushHeartbeat(file: string): Promise<void> {
  await live.get(file)?.writing;
}

export async function readHeartbeat(file: string): Promise<Heartbeat | null> {
  const r = await readJsonFile<Heartbeat>(file);
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return null;
  const hooks = r.data.hooks && typeof r.data.hooks === "object" ? r.data.hooks : {};
  return { version: typeof r.data.version === "string" ? r.data.version : "", hooks };
}
