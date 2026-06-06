// Thin git helpers for the session snapshot: commits since a timestamp and the
// files changed in the latest commit. Best-effort — returns empty on no git /
// not a repo, so the snapshot (and the resume digest built from it) degrades
// gracefully. Mirrors the execFileAsync pattern in branches.ts / git-watcher.ts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SessionCommit } from "./session.js";

const execFileAsync = promisify(execFile);

const MAX_COMMITS = 5;
const FIELD = "\x1f"; // unit separator — safe delimiter inside commit subjects

/** Commits since `sinceIso`, newest first, capped at MAX_COMMITS. When `sinceIso`
 *  is empty/invalid (first run), returns the most recent MAX_COMMITS as
 *  orientation rather than dumping the entire history. */
export async function getCommitsSince(
  projectRoot: string,
  sinceIso: string,
): Promise<SessionCommit[]> {
  const args = [
    "log",
    `--max-count=${MAX_COMMITS}`,
    "--no-merges",
    `--pretty=format:%h${FIELD}%s${FIELD}%aI`,
  ];
  if (Number.isFinite(Date.parse(sinceIso))) args.push(`--since=${sinceIso}`);

  try {
    const { stdout } = await execFileAsync("git", args, { cwd: projectRoot });
    const out: SessionCommit[] = [];
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const [hash, message, date] = t.split(FIELD);
      if (hash && message) out.push({ hash, message, date: date ?? "" });
    }
    return out;
  } catch {
    return [];
  }
}

/** Files changed in the latest commit (name-only). Empty on no git / shallow. */
export async function getDiffFiles(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD~1..HEAD"], {
      cwd: projectRoot,
    });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
