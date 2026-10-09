// Every git command Synthra runs on its own (status polling, branch, log,
// diff) goes through here, so a repository's own git settings can't make it
// start a program. Found by Hermes Agent v0.21.6 (#130661), checked on a test
// repo: plain `git status` and `git diff` ran a filter, an fsmonitor program
// and an external diff tool that the repo's .git/config named.
//
// What is switched off, per call:
//   - core.fsmonitor (a program `git status` runs to list changed files);
//   - clean, smudge and process filters defined in the repo's own config,
//     including files it includes (filters from your global config, such as
//     Git LFS, keep working);
//   - external diff tools and textconv, for `git diff`;
//   - submodules, whose own configs aren't read here: status and diff skip
//     them, and nothing recurses into them;
//   - signature checks in `git log` (log.showSignature makes git run the
//     repo's gpg.program on a signed commit; found by a security review);
//   - the pager;
//   - optional index writes (GIT_OPTIONAL_LOCKS=0), so `git status` never
//     rewrites the index and starts the post-index-change hook.
// A repo whose filter names can't be switched off safely gets no git call at
// all: callers already treat a failed call as "no git here".

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Local filter names, per repo, re-read after a while. */
const FILTER_TTL_MS = 60_000;
const filterMemo = new Map<string, { at: number; names: string[] }>();

/** The filter names in `git config -z --get-regexp` output: records end in
 *  NUL, each "key\nvalue". The key is `filter.<name>.<var>`; the name may hold
 *  dots and spaces, so it is everything between the first and last dot. */
export function filterNames(output: string): string[] {
  const names = new Set<string>();
  for (const record of output.split("\0")) {
    const key = record.split("\n", 1)[0] ?? "";
    if (!key.toLowerCase().startsWith("filter.")) continue;
    const last = key.lastIndexOf(".");
    if (last <= "filter.".length) continue;
    names.add(key.slice("filter.".length, last));
  }
  return [...names];
}

async function localFilters(cwd: string): Promise<string[]> {
  const hit = filterMemo.get(cwd);
  if (hit && Date.now() - hit.at < FILTER_TTL_MS) return hit.names;
  const names = new Set<string>();
  // The repo's own config (and what it includes), and its worktree config.
  // Reading config runs nothing.
  // Fails closed: any failure other than the known harmless ones throws, and
  // the caller skips git, rather than running git with filters left on.
  for (const scope of ["--local", "--worktree"]) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["config", scope, "--includes", "-z", "--get-regexp", "^filter\\."],
        { cwd },
      );
      for (const n of filterNames(stdout)) names.add(n);
    } catch (e) {
      const err = e as { code?: unknown; stderr?: unknown };
      const stderr = String(err.stderr ?? "");
      const harmless =
        err.code === 1 || // no filter keys
        /not a git repository|only be used inside a git repository/i.test(stderr) ||
        (scope === "--worktree" && /worktreeConfig/i.test(stderr));
      if (!harmless)
        throw new Error(
          `can't read this repo's git filters (${stderr.trim() || String(err.code)})`,
        );
    }
  }
  const list = [...names];
  filterMemo.set(cwd, { at: Date.now(), names: list });
  return list;
}

/** The `-c` options and arguments that keep a git command from running a
 *  program the repo names. Throws when a filter name can't be passed safely
 *  as `-c filter.<name>.<var>=`. Exported for the tests. */
export async function safeGitArgs(args: string[], cwd: string): Promise<string[]> {
  const opts = [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "submodule.recurse=false",
    // `git log` checks commit signatures with the repo's gpg.program when
    // log.showSignature is on; both can come from the repo's config.
    "-c",
    "log.showSignature=false",
  ];
  for (const n of await localFilters(cwd)) {
    if (/[=\n\r\0]/.test(n)) {
      throw new Error(`git filter "${n}" can't be switched off safely; skipping git here`);
    }
    for (const v of ["clean", "smudge", "process"]) opts.push("-c", `filter.${n}.${v}=`);
    opts.push("-c", `filter.${n}.required=false`);
  }
  const [sub, ...rest] = args;
  const body =
    sub === "diff"
      ? ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...rest]
      : sub === "status"
        ? ["status", "--ignore-submodules=all", ...rest]
        : sub === "log"
          ? ["log", "--no-show-signature", ...rest]
          : args;
  return [...opts, ...body];
}

/** Run git for Synthra's own bookkeeping, safely. Throws like execFile. */
export async function safeGit(
  args: string[],
  cwd: string,
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("git", await safeGitArgs(args, cwd), {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
  });
  return { stdout };
}
