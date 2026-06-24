// Per-session snapshot, captured at session end (Stop hook → /context-update)
// and read by the SessionStart primer to build the "Since you were last here"
// resume digest. Persisted to .synthra-graph/session.json (machine-local,
// gitignored): it describes THIS machine's last session and is regenerated every
// Stop, so there is no migration — a schema mismatch is simply treated as
// "no snapshot" and the primer degrades to its legacy output.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SESSION_SCHEMA_VERSION = 2;

export interface SessionCommit {
  hash: string;
  message: string;
  date: string;
}

export interface SessionSummary {
  tasks: string[];
  decisions: string[];
  next: string[];
}

export interface SessionState {
  schema_version: number;
  endedAt: string;
  branch: string;
  filesTouched: string[];
  recentCommits: SessionCommit[];
  summary: SessionSummary;
  /** HEAD sha at session end — baseline for the next session's "changed symbols"
   *  digest. Optional: absent in non-git projects (digest just omits the section). */
  headSha?: string;
}

export async function readSession(path: string): Promise<SessionState | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (parsed.schema_version !== SESSION_SCHEMA_VERSION) return null;
    return parsed as SessionState;
  } catch {
    return null;
  }
}

export async function writeSession(path: string, state: SessionState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}
