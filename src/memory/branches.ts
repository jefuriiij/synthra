// Branch-aware routing for the context store.
// On the default branch, reads/writes go to .synthra/context-store.json.
// On a feature branch, they go to .synthra/branches/<sanitized-branch>/context-store.json.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function currentBranch(projectRoot: string): Promise<string> {
  // Try .git/HEAD first — avoids the subprocess cost and works for detached
  // worktrees too (.git is a file there).
  try {
    const headPath = join(projectRoot, ".git", "HEAD");
    const head = await readFile(headPath, "utf8");
    const trimmed = head.trim();
    const match = trimmed.match(/^ref:\s+refs\/heads\/(.+)$/);
    if (match?.[1]) return match[1];
    // Detached HEAD — fall through
  } catch {
    // .git/HEAD unreadable (worktree file, submodule, or not a git repo)
  }

  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: projectRoot,
    });
    const name = stdout.trim();
    if (name) return name;
  } catch {
    // git not on PATH or not a repo
  }

  return "main";
}

export async function defaultBranch(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      { cwd: projectRoot },
    );
    const trimmed = stdout.trim();
    const match = trimmed.match(/^origin\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch {
    // No origin/HEAD set — fall back to heuristic
  }
  return "main";
}

export function sanitizeBranchName(name: string): string {
  return name.replaceAll("/", "-").replaceAll("\\", "-");
}

export interface BranchScopedPaths {
  contextStore: string;
  contextMd: string;
  branchDir: string | null;
}

export function resolveBranchPaths(
  contextDir: string,
  branch: string,
  isDefault: boolean,
): BranchScopedPaths {
  if (isDefault) {
    return {
      contextStore: join(contextDir, "context-store.json"),
      contextMd: join(contextDir, "CONTEXT.md"),
      branchDir: null,
    };
  }
  const branchDir = join(contextDir, "branches", sanitizeBranchName(branch));
  return {
    contextStore: join(branchDir, "context-store.json"),
    contextMd: join(branchDir, "CONTEXT.md"),
    branchDir,
  };
}
