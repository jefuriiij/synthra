// Every git command Synthra runs on its own (status polling, branch, log,
// diff) goes through here, so a repository's own git settings can't make it
// start a program. Found by Hermes Agent v0.21.6 (#130661), checked on a test
// repo: plain `git status` and `git diff` ran a filter, an fsmonitor program
// and an external diff tool that the repo's .git/config named.
//
// What is switched off, per call:
//   - core.fsmonitor (a program `git status` runs to list changed files);
//   - clean, smudge and process filters defined in the repo's own config
//     (filters from your global config, such as Git LFS, keep working);
//   - external diff tools and textconv, for `git diff`;
//   - optional index writes (GIT_OPTIONAL_LOCKS=0), so `git status` never
//     rewrites the index and starts the post-index-change hook.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Local filter names, per repo, re-read after a while (a repo's config can
 *  change while Synthra runs). */
const FILTER_TTL_MS = 60_000;
const filterMemo = new Map<string, { at: number; names: string[] }>();

async function localFilters(cwd: string): Promise<string[]> {
  const hit = filterMemo.get(cwd);
  if (hit && Date.now() - hit.at < FILTER_TTL_MS) return hit.names;
  let names: string[] = [];
  try {
    // Reading config runs nothing.
    const { stdout } = await execFileAsync(
      "git",
      ["config", "--local", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
      { cwd },
    );
    names = [
      ...new Set(
        stdout
          .split("\n")
          .map((l) => /^filter\.(.+)\.(?:clean|smudge|process)\s/.exec(l)?.[1])
          .filter((n): n is string => typeof n === "string" && n.length > 0),
      ),
    ];
  } catch {
    // Exit code 1 = no such keys; not a repo = nothing to switch off.
  }
  filterMemo.set(cwd, { at: Date.now(), names });
  return names;
}

/** The `-c` options and arguments that keep a git command from running a
 *  program the repo names. Exported for the tests. */
export async function safeGitArgs(args: string[], cwd: string): Promise<string[]> {
  const opts = ["-c", "core.fsmonitor=false"];
  for (const n of await localFilters(cwd)) {
    opts.push(
      "-c",
      `filter.${n}.clean=`,
      "-c",
      `filter.${n}.smudge=`,
      "-c",
      `filter.${n}.process=`,
      "-c",
      `filter.${n}.required=false`,
    );
  }
  const [sub, ...rest] = args;
  const body = sub === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...rest] : args;
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
