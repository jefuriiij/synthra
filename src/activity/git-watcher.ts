// Watches `.git/HEAD` for branch switches (via fs.watch) and polls
// `git status --porcelain` every ~2s to surface uncommitted-diff changes.
// Always best-effort: in a non-git directory or when git is missing, the
// watcher simply emits nothing.

import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GitEvent } from "./activity-log.js";

const execFileAsync = promisify(execFile);

const POLL_MS = 2000;

export interface GitWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Re-read .git/HEAD now. This is what the fs.watch callback calls; exposed
   *  so the re-entrancy guard can be tested without depending on FS event
   *  timing, which differs per platform and is flaky under CI load. */
  checkNow(): Promise<void>;
}

export type GitEventHandler = (e: GitEvent) => void | Promise<void>;

async function readHeadBranch(projectRoot: string): Promise<string | null> {
  try {
    const head = await readFile(join(projectRoot, ".git", "HEAD"), "utf8");
    const m = head.trim().match(/^ref:\s+refs\/heads\/(.+)$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readStatusPorcelain(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
    });
    return stdout;
  } catch {
    return null;
  }
}

export function createGitWatcher(root: string, onEvent: GitEventHandler): GitWatcher {
  let headWatcher: FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let lastBranch: string | null = null;
  let lastStatus: string | null = null;

  const emitSafe = async (event: GitEvent) => {
    try {
      await onEvent(event);
    } catch {
      // swallow
    }
  };

  let headBusy = false;
  let headDirty = false;

  // fs.watch fires 2-3x for a single `git checkout` on Windows, and the
  // branch comparison below only happens after an await — so overlapping calls
  // would each still see the old lastBranch, each emit branch-switch, and each
  // kick off a rescan of the same tree. Serialize, and re-check once at the end
  // if HEAD moved again while we were emitting.
  const checkHead = async () => {
    if (headBusy) {
      headDirty = true;
      return;
    }
    headBusy = true;
    try {
      do {
        headDirty = false;
        const branch = await readHeadBranch(root);
        if (branch && branch !== lastBranch) {
          const prev = lastBranch;
          lastBranch = branch;
          if (prev !== null) {
            await emitSafe({
              kind: "branch-switch",
              details: { from: prev, to: branch },
              ts: new Date().toISOString(),
            });
          }
        }
      } while (headDirty);
    } finally {
      headBusy = false;
    }
  };

  const pollStatus = async () => {
    const status = await readStatusPorcelain(root);
    if (status === null) return;
    if (lastStatus !== null && status !== lastStatus) {
      const prevFiles = parseStatusFiles(lastStatus);
      const nowFiles = parseStatusFiles(status);
      const added = nowFiles.filter((f) => !prevFiles.includes(f));
      const removed = prevFiles.filter((f) => !nowFiles.includes(f));
      await emitSafe({
        kind: "diff-change",
        details: {
          changed_count: nowFiles.length,
          newly_dirty: added,
          newly_clean: removed,
        },
        ts: new Date().toISOString(),
      });
    }
    lastStatus = status;
  };

  return {
    checkNow: checkHead,

    async start() {
      // Seed initial branch + status so the first real change emits an event
      // rather than a stale "from null".
      lastBranch = await readHeadBranch(root);
      lastStatus = await readStatusPorcelain(root);

      try {
        headWatcher = watch(join(root, ".git", "HEAD"), () => {
          void checkHead();
        });
        // fs.watch emits "error" for transient OS issues (EPERM on lock
        // files, ENOENT when refs get rewritten). Swallow them — we never
        // want a transient FS event to crash the syn process.
        headWatcher.on("error", () => {
          // silent — branch-switch detection is best-effort
        });
      } catch {
        // .git/HEAD not present — silently no-op
      }

      pollTimer = setInterval(() => {
        void pollStatus();
      }, POLL_MS);
      pollTimer.unref?.();
    },

    async stop() {
      if (headWatcher) {
        headWatcher.close();
        headWatcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}

function parseStatusFiles(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter((l) => l.length > 0);
}
