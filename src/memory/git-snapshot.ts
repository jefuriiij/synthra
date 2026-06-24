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

/** Current HEAD sha. Empty on no git — stored at session end as the baseline to
 *  diff against next session for the "changed symbols" digest. */
export async function getHeadSha(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Parse `git diff -U0` output into Map<path, [start,end][]> of CHANGED line
 *  ranges on the NEW side. Pure (no git) so it's unit-testable. A hunk header is
 *  `@@ -a,b +c,d @@`: the new side is `+c,d` (d omitted = 1 line; d=0 = a pure
 *  deletion at c — recorded as the single adjacent line so a symbol there still
 *  flags). The file comes from the `+++ b/<path>` line (`/dev/null` = deleted). */
export function parseDiffHunks(stdout: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? null : p.replace(/^b\//, "");
    } else if (current && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const end = count === 0 ? start : start + count - 1;
      const list = out.get(current) ?? [];
      list.push([start, end]);
      out.set(current, list);
    }
  }
  return out;
}

/** Changed line ranges (new-side coords) for every file modified since
 *  `sinceRef` — committed AND uncommitted working-tree changes. Best-effort:
 *  empty on no git / unreachable ref. */
export async function getChangedLineRanges(
  projectRoot: string,
  sinceRef: string,
): Promise<Map<string, Array<[number, number]>>> {
  if (!sinceRef) return new Map();
  try {
    const { stdout } = await execFileAsync("git", ["diff", "-U0", "--no-color", sinceRef, "--"], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseDiffHunks(stdout);
  } catch {
    return new Map();
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
