// Git helpers for the session snapshot. The critical guarantee is graceful
// degradation (never throw on a non-repo); the parse path is exercised against
// a real throwaway repo when git is available.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCommitsSince, getDiffFiles } from "../src/memory/git-snapshot.js";

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
