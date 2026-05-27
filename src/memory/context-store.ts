// Structured decisions/tasks/facts that persist across sessions.
// Stored in .synthra/ (GIT-TRACKED) so teammates inherit them.
// Branch-partitioned via branches.ts.
// TODO: M4 — improvement #2

export type EntryKind = "decision" | "task" | "next" | "fact" | "blocker";

export interface ContextEntry {
  type: EntryKind;
  content: string;
  tags: string[];
  files: string[];
  date: string;
}

export async function readEntries(_path: string): Promise<ContextEntry[]> {
  throw new Error("Synthra: readEntries not yet implemented (M4)");
}

export async function appendEntry(_path: string, _entry: ContextEntry): Promise<void> {
  throw new Error("Synthra: appendEntry not yet implemented (M4)");
}
