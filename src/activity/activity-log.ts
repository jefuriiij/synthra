// Rolling JSONL log of human activity, written to .synthra-graph/activity.jsonl.
// Capped at ~100 most recent events.
// TODO: M5 — improvement #3

export interface FileEvent {
  kind: "save" | "create" | "delete";
  path: string;
  ts: string;
}

export interface GitEvent {
  kind: "branch-switch" | "stage" | "unstage" | "diff-change";
  details: Record<string, unknown>;
  ts: string;
}

export type ActivityEvent = FileEvent | GitEvent;

export async function appendActivity(_path: string, _event: ActivityEvent): Promise<void> {
  throw new Error("Synthra: appendActivity not yet implemented (M5)");
}

export async function readRecent(
  _path: string,
  _sinceMs?: number,
): Promise<ActivityEvent[]> {
  throw new Error("Synthra: readRecent not yet implemented (M5)");
}
