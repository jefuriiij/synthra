// v0.26 — branch-switch detection must be re-entrant.
//
// fs.watch fires 2-3x for a single `git checkout` on Windows, and checkHead
// compares the branch only AFTER an await — so overlapping calls each still saw
// the old lastBranch, each emitted branch-switch, and each kicked off a rescan
// of the same tree.

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitWatcher } from "../src/activity/git-watcher.js";
import type { GitEvent } from "../src/activity/activity-log.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function repoLike(branch: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syn-gitw-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");
  return dir;
}

const setBranch = (dir: string, branch: string) =>
  writeFile(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");

describe("createGitWatcher branch-switch", () => {
  it("emits once for a switch even when the watcher fires repeatedly", async () => {
    const dir = await repoLike("main");
    const events: GitEvent[] = [];
    const w = createGitWatcher(dir, async (e) => {
      // A slow handler widens the window a second call could slip through —
      // this is the rescan that used to get started twice.
      await sleep(30);
      events.push(e);
    });
    await w.start();
    try {
      await setBranch(dir, "feature/x");
      // Three watcher notifications for one checkout, as Windows delivers them.
      await Promise.all([w.checkNow(), w.checkNow(), w.checkNow()]);
      await sleep(150);

      const switches = events.filter((e) => e.kind === "branch-switch");
      expect(switches).toHaveLength(1);
      expect((switches[0]?.details as { to?: string })?.to).toBe("feature/x");
    } finally {
      await w.stop();
    }
  });

  it("still catches a second switch that lands while the first is emitting", async () => {
    const dir = await repoLike("main");
    const seen: string[] = [];
    const w = createGitWatcher(dir, async (e) => {
      if (e.kind !== "branch-switch") return;
      seen.push((e.details as { to?: string })?.to ?? "?");
      await sleep(40);
    });
    await w.start();
    try {
      await setBranch(dir, "feature/x");
      void w.checkNow();
      await sleep(10); // first emit is in flight
      await setBranch(dir, "feature/y");
      void w.checkNow(); // arrives mid-emit — must not be dropped
      await sleep(250);

      expect(seen).toEqual(["feature/x", "feature/y"]);
    } finally {
      await w.stop();
    }
  });
});
