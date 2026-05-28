// GET /activity?since=<ms> — returns recent human-activity events.
// Backed by the in-memory ActivityStore (file-watcher + git-watcher feed it).
// MCP tool `recent_activity` is a thin wrapper.

import type { ActivityEvent } from "../../activity/activity-log.js";
import type { ServerContext } from "../context.js";

export interface ActivityResponse {
  events: ActivityEvent[];
  since: string;
  ring_size: number;
}

export async function handleActivity(
  sinceMs: number | undefined,
  ctx: ServerContext,
): Promise<ActivityResponse> {
  const events = ctx.activity.getEvents(sinceMs);
  return {
    events,
    since: new Date(sinceMs ?? Date.now()).toISOString(),
    ring_size: ctx.activity.size(),
  };
}
