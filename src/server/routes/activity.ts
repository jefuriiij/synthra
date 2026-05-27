// GET /activity?since=<iso-or-ms> — returns recent human-activity events.
// MCP tool `recent_activity` is a thin wrapper over this.
// TODO: M5 — improvement #3

import type { ActivityEvent } from "../../activity/activity-log.js";

export interface ActivityResponse {
  events: ActivityEvent[];
  since: string;
}

export async function handleActivity(_sinceMs?: number): Promise<ActivityResponse> {
  throw new Error("Synthra: handleActivity not yet implemented (M5)");
}
