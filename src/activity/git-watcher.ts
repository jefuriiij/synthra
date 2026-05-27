// Watches .git/HEAD for branch switches and polls `git status --porcelain`
// every ~2s for uncommitted-diff changes.
// TODO: M5 — improvement #3

import type { GitEvent } from "./activity-log.js";

export interface GitWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type GitEventHandler = (e: GitEvent) => void | Promise<void>;

export function createGitWatcher(_root: string, _onEvent: GitEventHandler): GitWatcher {
  throw new Error("Synthra: createGitWatcher not yet implemented (M5)");
}
