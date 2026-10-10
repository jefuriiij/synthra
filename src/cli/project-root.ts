// Finding the project and its live server from a folder: what `syn mcp` and
// `syn hook` (both started by Codex in the session's folder) need first. Kept
// apart from the server code so `syn hook`, which Codex starts on every tool
// call, loads little.

import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { checkOwner } from "../server/owner.js";
import { resolvePaths } from "../shared/paths.js";

/** The header Codex's hooks and `syn mcp` send, so the server can tell their
 *  calls from Claude Code's. */
export const VIA_HEADER = "x-synthra-via";

/** The nearest folder at or above `start` that Synthra has mapped. */
export async function findProjectRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    try {
      if ((await stat(resolvePaths(dir).graphDir)).isDirectory()) return dir;
    } catch {
      // Not here: look one folder up.
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The project's live server: its port, and an id for this server instance
 *  (a restart can reuse the port). Null when none answers for this root. */
export async function liveServer(root: string): Promise<{ port: number; id: string } | null> {
  const owner = await checkOwner(resolvePaths(root));
  if (owner.state !== "live") return null;
  const { port, pid, startedAt } = owner.record;
  return { port, id: `${port}:${pid}:${startedAt}` };
}
