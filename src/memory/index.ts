// High-level orchestration: branch detection + store routing + CONTEXT.md
// refresh in one call. Used by the MCP tools and the /context-update route.

import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import {
  currentBranch,
  defaultBranch,
  resolveBranchPaths,
  type BranchScopedPaths,
} from "./branches.js";
import { deriveContextMd, readContextMd, writeContextMd } from "./context-md.js";
import {
  appendEntry,
  readStore,
  type ContextEntry,
  type EntryAnchor,
  type EntryKind,
} from "./context-store.js";

export interface ActiveBranch {
  branch: string;
  isDefault: boolean;
  paths: BranchScopedPaths;
}

export async function resolveActiveBranch(
  paths: SynthraPaths,
  override?: string,
): Promise<ActiveBranch> {
  const branch = override ?? (await currentBranch(paths.projectRoot));
  const def = await defaultBranch(paths.projectRoot);
  const isDefault = branch === def;
  return {
    branch,
    isDefault,
    paths: resolveBranchPaths(paths.contextDir, branch, isDefault),
  };
}

/**
 * Write CONTEXT.md from the store — unless that would replace a real narrative
 * with an empty one.
 *
 * Refusing on a corrupt read isn't enough on its own: quarantining the damaged
 * store MOVES it, which turns "corrupt" into "missing" on the very next read, and
 * missing legitimately means empty. The Stop hook then published "no context
 * entries yet" over a git-tracked file one step later. Guarding on the outcome
 * instead of the cause also covers a deleted store and a mis-resolved branch.
 *
 * The trade: someone who deliberately empties their store keeps a stale
 * CONTEXT.md until the next real entry. That's visible and recoverable, unlike
 * silently committing the loss of the narrative.
 */
async function publishContextMd(
  path: string,
  entries: ContextEntry[],
  branch: string,
): Promise<boolean> {
  if (entries.length === 0) {
    const existing = await readContextMd(path);
    if (existing && existing.trim().length > 0) {
      log.warn(
        `${path} already has content and the store is empty — leaving it alone rather than replacing it with an empty narrative.`,
      );
      return false;
    }
  }
  await writeContextMd(path, deriveContextMd(entries, branch));
  return true;
}

export interface RememberInput {
  text: string;
  kind: EntryKind;
  tags?: string[];
  files?: string[];
  /** Content-hash snapshots of linked files (resolved by the caller against the
   *  live graph) — powers the "possibly stale" flag at recall time. */
  anchors?: EntryAnchor[];
}

export interface RememberResult {
  entry: ContextEntry;
  branch: string;
  storePath: string;
  contextMdPath: string;
  /** Set when the store couldn't be parsed, so nothing was saved. */
  unreadable?: string;
}

export async function rememberEntry(
  paths: SynthraPaths,
  input: RememberInput,
): Promise<RememberResult> {
  const active = await resolveActiveBranch(paths);
  const entry: ContextEntry = {
    type: input.kind,
    content: input.text,
    tags: input.tags ?? [],
    files: input.files ?? [],
    date: new Date().toISOString(),
    ...(input.anchors && input.anchors.length > 0 ? { anchors: input.anchors } : {}),
  };
  const written = await appendEntry(active.paths.contextStore, entry);

  if (written.status === "corrupt") {
    // Do NOT derive CONTEXT.md here. Deriving from a store we couldn't read is
    // what turned one bad read into a committed loss of a git-tracked file.
    log.error(
      `${active.paths.contextStore} could not be parsed (${written.error}) — nothing was saved, and CONTEXT.md was left alone.` +
        (written.quarantined ? ` A copy is at ${written.quarantined}.` : ""),
    );
    return {
      entry,
      branch: active.branch,
      storePath: active.paths.contextStore,
      contextMdPath: active.paths.contextMd,
      unreadable: written.error,
    };
  }

  // Refresh CONTEXT.md so the narrative stays in sync with the structured store.
  await publishContextMd(
    active.paths.contextMd,
    written.status === "written" ? written.data.entries : [],
    active.branch,
  );

  return {
    entry,
    branch: active.branch,
    storePath: active.paths.contextStore,
    contextMdPath: active.paths.contextMd,
  };
}

export interface RecallInput {
  kind?: EntryKind;
  branch?: string;
  limit?: number;
}

export interface RecallResult {
  branch: string;
  entries: ContextEntry[];
  storePath: string;
  /** Set when the store couldn't be parsed — an empty `entries` then means
   *  "unreadable", not "nothing stored". */
  unreadable?: string;
}

export async function recallEntries(
  paths: SynthraPaths,
  input: RecallInput = {},
): Promise<RecallResult> {
  const active = await resolveActiveBranch(paths, input.branch);
  const read = await readStore(active.paths.contextStore);
  if (read.status === "corrupt") {
    // Say so instead of implying the store is empty — "you have no memory" and
    // "your memory file is damaged" need very different reactions.
    return {
      branch: active.branch,
      entries: [],
      storePath: active.paths.contextStore,
      unreadable: read.error,
    };
  }
  let entries = read.entries;
  if (input.kind) entries = entries.filter((e) => e.type === input.kind);
  if (input.limit && input.limit > 0) entries = entries.slice(-input.limit);
  return {
    branch: active.branch,
    entries,
    storePath: active.paths.contextStore,
  };
}

export async function refreshContextMd(paths: SynthraPaths, branchOverride?: string) {
  const active = await resolveActiveBranch(paths, branchOverride);
  const read = await readStore(active.paths.contextStore);

  // The Stop hook calls this after every session. Rewriting the git-tracked
  // CONTEXT.md from an unreadable store would replace a real narrative with
  // "no context entries yet" — so leave it exactly as it is.
  if (read.status === "corrupt") {
    log.error(
      `${active.paths.contextStore} could not be parsed (${read.error}) — CONTEXT.md was left untouched.`,
    );
    return {
      branch: active.branch,
      path: active.paths.contextMd,
      entriesSeen: 0,
      unreadable: read.error,
    };
  }

  await publishContextMd(active.paths.contextMd, read.entries, active.branch);
  return {
    branch: active.branch,
    path: active.paths.contextMd,
    entriesSeen: read.entries.length,
  };
}
