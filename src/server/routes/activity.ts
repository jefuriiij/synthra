// GET /activity?since=<ms> — returns recent human-activity events.
// Stub for M2 — full chokidar + git watcher wired in M5.

import type { ServerContext } from "../context.js";

export interface ActivityEvent {
  ts: number;
  kind: "save" | "branch" | "diff";
  payload: Record<string, unknown>;
}

export interface ActivityResponse {
  events: ActivityEvent[];
  since: string;
}

export async function handleActivity(
  sinceMs: number | undefined,
  _ctx: ServerContext,
): Promise<ActivityResponse> {
  return { events: [], since: new Date(sinceMs ?? Date.now()).toISOString() };
}
