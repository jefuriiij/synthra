// Structured decisions/tasks/facts that persist across sessions.
// Stored in .synthra/ (GIT-TRACKED) so teammates inherit them.
// Branch-partitioned via branches.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type EntryKind = "decision" | "task" | "next" | "fact" | "blocker";

export interface ContextEntry {
  type: EntryKind;
  content: string;
  tags: string[];
  files: string[];
  date: string;
  /** Provenance. Reserved for v2 auto-capture; v1 only writes manual entries, so
   *  the field is omitted today and read back as undefined (treated as manual). */
  source?: "manual" | "auto";
}

interface Store {
  schema_version: number;
  entries: ContextEntry[];
}

const SCHEMA_VERSION = 1;

export async function readEntries(path: string): Promise<ContextEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export async function writeEntries(path: string, entries: ContextEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const store: Store = { schema_version: SCHEMA_VERSION, entries };
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export async function appendEntry(path: string, entry: ContextEntry): Promise<void> {
  const entries = await readEntries(path);
  entries.push(entry);
  await writeEntries(path, entries);
}
