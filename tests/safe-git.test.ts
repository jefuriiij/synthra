// v0.40.2 — Synthra runs git on its own (status polling, branch, log, diff).
// A repository's own .git/config can name programs those commands start: a
// clean filter, an fsmonitor program, an external diff tool, a textconv. This
// builds such a repo, shows that plain git runs them, and that Synthra's git
// runs none, while its answers stay right.

import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getChangedLineRanges } from "../src/memory/git-snapshot.js";
import { safeGit, safeGitArgs } from "../src/shared/git.js";

const run = promisify(execFile);
const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

async function evilRepo(): Promise<{ repo: string; markers: string }> {
  const repo = await mkdtemp(join(tmpdir(), "syn-evil-git-"));
  const markers = await mkdtemp(join(tmpdir(), "syn-evil-markers-"));
  const m = markers.replace(/\\/g, "/");
  const git = (...a: string[]) => run("git", a, { cwd: repo });
  await git("init", "-q");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");
  await writeFile(join(repo, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("commit", "-qm", "one");
  // Each planted program leaves a marker file when it runs.
  await git("config", "filter.evil.clean", `sh -c 'touch "${m}/filter-clean"; cat'`);
  await git("config", "filter.evil.smudge", "cat");
  await git("config", "core.fsmonitor", `sh -c 'touch "${m}/fsmonitor"'`);
  await git("config", "diff.external", `sh -c 'touch "${m}/diff-external"'`);
  await writeFile(join(repo, ".gitattributes"), "* filter=evil diff=evil\n");
  await writeFile(join(repo, "a.txt"), "two\n");
  return { repo, markers };
}

describe.runIf(hasGit)("Synthra's own git calls run no program a repo names", () => {
  it("plain git does run them (the repo is really hostile)", async () => {
    const { repo, markers } = await evilRepo();
    await run("git", ["status", "--porcelain"], { cwd: repo }).catch(() => undefined);
    await run("git", ["diff", "HEAD"], { cwd: repo }).catch(() => undefined);
    expect((await readdir(markers)).length).toBeGreaterThan(0);
  }, 30_000);

  it("safeGit runs none, and still reports the change", async () => {
    const { repo, markers } = await evilRepo();
    const status = await safeGit(["status", "--porcelain"], repo);
    expect(status.stdout).toContain("a.txt");
    const diff = await safeGit(["diff", "-U0", "--no-color", "HEAD", "--"], repo);
    expect(diff.stdout).toContain("+two");
    expect((await getChangedLineRanges(repo, "HEAD")).has("a.txt")).toBe(true);
    expect(await readdir(markers)).toEqual([]);
  }, 30_000);

  it("switches off only the repo's own filters, and diff tools only for diff", async () => {
    const { repo } = await evilRepo();
    const status = await safeGitArgs(["status"], repo);
    expect(status).toContain("core.fsmonitor=false");
    expect(status).toContain("filter.evil.clean=");
    expect(status).not.toContain("--no-ext-diff");
    const diff = await safeGitArgs(["diff", "HEAD"], repo);
    expect(diff.slice(diff.indexOf("diff"))).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
    ]);
    // A folder with no repo config: only the fsmonitor switch.
    const plain = await mkdtemp(join(tmpdir(), "syn-plain-"));
    await mkdir(plain, { recursive: true });
    expect(await safeGitArgs(["status"], plain)).toEqual(["-c", "core.fsmonitor=false", "status"]);
  }, 30_000);
});
