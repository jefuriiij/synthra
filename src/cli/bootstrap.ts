// Project bootstrap: creates .synthra-graph/, .synthra/, updates .gitignore,
// patches CLAUDE.md with the versioned policy block.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { patchClaudeMd } from "../hooks/claude-md.js";
import type { SynthraPaths } from "../shared/paths.js";

export interface BootstrapResult {
  graphCreated: boolean;
  contextCreated: boolean;
  gitignoreUpdated: boolean;
  claudeMdUpdated: boolean;
  claudeMdCreated: boolean;
}

const GITIGNORE_MARKER = "# added by synthra";
const GITIGNORE_ENTRY = ".synthra-graph/";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<boolean> {
  const had = await exists(path);
  await mkdir(path, { recursive: true });
  return !had;
}

async function patchGitignore(path: string): Promise<boolean> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    /* file may not exist */
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((l) => l.trim() === GITIGNORE_ENTRY)) return false;

  const appendix = (existing.length === 0 || existing.endsWith("\n") ? "" : "\n") +
    (existing.length ? "\n" : "") +
    `${GITIGNORE_MARKER}\n${GITIGNORE_ENTRY}\n`;
  await writeFile(path, existing + appendix, "utf8");
  return true;
}

export async function bootstrap(paths: SynthraPaths): Promise<BootstrapResult> {
  const graphCreated = await ensureDir(paths.graphDir);
  const contextCreated = await ensureDir(paths.contextDir);
  const gitignoreUpdated = await patchGitignore(paths.gitignore);

  const claudeMdExistedBefore = await exists(paths.claudeMd);
  const patch = await patchClaudeMd(paths.claudeMd);

  return {
    graphCreated,
    contextCreated,
    gitignoreUpdated,
    claudeMdUpdated: patch.updated,
    claudeMdCreated: patch.created && !claudeMdExistedBefore,
  };
}
