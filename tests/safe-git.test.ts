// v0.40.2 — Synthra runs git on its own (status polling, branch, log, diff).
// A repository's own .git/config can name programs those commands start: a
// clean filter, an fsmonitor program, an external diff tool, a textconv. This
// builds such a repo, shows that plain git runs them, and that Synthra's git
// runs none, while its answers stay right.

import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getChangedLineRanges } from "../src/memory/git-snapshot.js";
import { filterNames, safeGit, safeGitArgs } from "../src/shared/git.js";

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
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    expect((await getChangedLineRanges(repo, head)).has("a.txt")).toBe(true);
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
      "--ignore-submodules=all",
      "HEAD",
    ]);
    // A folder with no repo config: only the fsmonitor and submodule switches.
    const plain = await mkdtemp(join(tmpdir(), "syn-plain-"));
    await mkdir(plain, { recursive: true });
    expect(await safeGitArgs(["status"], plain)).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "submodule.recurse=false",
      "status",
      "--ignore-submodules=all",
    ]);
  }, 30_000);
});

// v0.40.3 — the gaps a security review found in 0.40.2's version.
describe.runIf(hasGit)("safe git: names, includes, submodules, and the diff base", () => {
  it("reads filter names exactly, dots and spaces included", () => {
    const out = [
      "filter.a.b c.clean\nX",
      "filter.lfs.smudge\ngit-lfs smudge",
      "core.editor\nvi",
      "filter.x.required",
      "",
    ].join("\0");
    expect(filterNames(out).sort()).toEqual(["a.b c", "lfs", "x"]);
  });

  it("switches off a filter defined in an included config file", async () => {
    const { repo } = await evilRepo();
    const inc = join(repo, ".git", "evil.inc");
    const g = (...a: string[]) => run("git", a, { cwd: repo });
    const plant = (dir: string) =>
      g(
        "config",
        "--file",
        inc,
        "filter.sneaky.clean",
        `sh -c 'touch "${slash(dir)}/included"; cat'`,
      );
    await g("config", "include.path", "evil.inc");
    await writeFile(join(repo, ".gitattributes"), "* filter=sneaky\n");

    // Plain git follows the include and runs it...
    const seen = await mkdtemp(join(tmpdir(), "syn-inc-plain-"));
    await plant(seen);
    // Same size as the committed "one", so git must compare content (and filter).
    await writeFile(join(repo, "a.txt"), "abc\n");
    await run("git", ["status", "--porcelain"], { cwd: repo }).catch(() => undefined);
    expect(await readdir(seen)).toEqual(["included"]);

    // ...Synthra's git doesn't.
    const safe = await mkdtemp(join(tmpdir(), "syn-inc-safe-"));
    await plant(safe);
    await writeFile(join(repo, "a.txt"), "xyz\n");
    await safeGit(["status", "--porcelain"], repo);
    expect(await readdir(safe)).toEqual([]);
  }, 30_000);

  it("doesn't look inside submodules, whose own config may name programs", async () => {
    const g = (cwd: string, ...a: string[]) => run("git", a, { cwd });
    const sub = await mkdtemp(join(tmpdir(), "syn-evil-sub-"));
    await g(sub, "init", "-q");
    await g(sub, "config", "user.email", "t@t");
    await g(sub, "config", "user.name", "t");
    await writeFile(join(sub, "s.txt"), "s\n");
    await g(sub, "add", "s.txt");
    await g(sub, "commit", "-qm", "s");
    const { repo } = await evilRepo();
    await g(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    const markers = await mkdtemp(join(tmpdir(), "syn-evil-submarkers-"));
    const inner = join(repo, "sub");
    await g(inner, "config", "core.fsmonitor", `sh -c 'touch "${slash(markers)}/sub-fsmonitor"'`);
    await g(
      inner,
      "config",
      "filter.subevil.clean",
      `sh -c 'touch "${slash(markers)}/sub-filter"; cat'`,
    );
    await writeFile(join(inner, ".gitattributes"), "* filter=subevil\n");
    // Same size as the committed "s", so git must compare content (and filter).
    await writeFile(join(inner, "s.txt"), "t\n");
    // Plain git in the parent runs the submodule's fsmonitor (checked by hand
    // too). 0.40.2 already blocked that one (-c reaches submodules); skipping
    // submodules also keeps their filters out.
    await run("git", ["status", "--porcelain"], { cwd: repo });
    expect(await readdir(markers)).toContain("sub-fsmonitor");

    const safe = await mkdtemp(join(tmpdir(), "syn-evil-submarkers-safe-"));
    await g(inner, "config", "core.fsmonitor", `sh -c 'touch "${slash(safe)}/sub-fsmonitor"'`);
    await g(
      inner,
      "config",
      "filter.subevil.clean",
      `sh -c 'touch "${slash(safe)}/sub-filter"; cat'`,
    );
    await safeGit(["status", "--porcelain"], repo);
    await safeGit(["diff", "HEAD"], repo).catch(() => undefined);
    expect(await readdir(safe)).toEqual([]);
  }, 60_000);

  it("never passes a diff base that isn't a commit id", async () => {
    const { repo } = await evilRepo();
    const target = join(repo, "written-by-git.txt");
    expect((await getChangedLineRanges(repo, `--output=${target}`)).size).toBe(0);
    await expect(stat(target)).rejects.toThrow();
  }, 30_000);
});

function slash(p: string): string {
  return p.split("\\").join("/");
}
