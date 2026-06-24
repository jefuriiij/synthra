// Git helpers for the session snapshot. The critical guarantee is graceful
// degradation (never throw on a non-repo); the parse path is exercised against
// a real throwaway repo when git is available.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCommitsSince, getDiffFiles, parseDiffHunks } from "../src/memory/git-snapshot.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "syn-git-"));
}

describe("parseDiffHunks", () => {
  it("parses new-side line ranges per file (count omitted = 1, deletion = single line)", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      "+added",
      "@@ -10,0 +12,2 @@",
      "+x",
      "+y",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -5 +5 @@",
      "-old",
      "+new",
      "@@ -8,2 +7,0 @@", // pure deletion → single adjacent line
      "-gone1",
      "-gone2",
    ].join("\n");
    const out = parseDiffHunks(diff);
    expect(out.get("src/a.ts")).toEqual([
      [1, 3],
      [12, 13],
    ]);
    expect(out.get("src/b.ts")).toEqual([
      [5, 5],
      [7, 7],
    ]);
  });

  it("skips deleted files (+++ /dev/null)", () => {
    const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,5 +0,0 @@", "-stuff"].join("\n");
    expect(parseDiffHunks(diff).size).toBe(0);
  });
});

describe("git-snapshot graceful degradation", () => {
  it("returns [] for a non-git directory (never throws)", async () => {
    const dir = await tmpDir();
    expect(await getCommitsSince(dir, "")).toEqual([]);
    expect(await getDiffFiles(dir)).toEqual([]);
  });
});

describe.skipIf(!gitAvailable())("git-snapshot against a real repo", () => {
  it("parses recent commits (hash + message)", async () => {
    const dir = await tmpDir();
    const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    run(["init"]);
    run(["config", "user.email", "t@t.dev"]);
    run(["config", "user.name", "Test"]);
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    run(["add", "."]);
    run(["commit", "-m", "first commit"]);

    const commits = await getCommitsSince(dir, "");
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0]?.message).toBe("first commit");
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{7,}$/);
  });
});
