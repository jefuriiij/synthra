// `syn <folder>` used to create the folder when it didn't exist, then set
// Synthra up inside it. So any word sade didn't know as a command became a new
// project: `syn codex` on a version without that command made an empty
// `codex/` folder full of Synthra files, and a typo would do the same (v0.41).
// The commands that write into a project now check first and create nothing.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { log } from "../shared/logger.js";

/** Why `rawPath` can't be a project folder, or null when it can. */
export async function folderProblem(rawPath: string): Promise<string | null> {
  const full = resolve(rawPath);
  try {
    if ((await stat(full)).isDirectory()) return null;
    return `"${rawPath}" is a file, not a folder (${full}).`;
  } catch {
    return `No folder named "${rawPath}" here (${full}). Synthra won't create one. Did you mean a command? Run \`syn --help\`.`;
  }
}

/** True when `rawPath` is a folder; otherwise says why and sets exit code 1. */
export async function requireFolder(rawPath: string): Promise<boolean> {
  const problem = await folderProblem(rawPath);
  if (!problem) return true;
  log.error(problem);
  process.exitCode = 1;
  return false;
}
