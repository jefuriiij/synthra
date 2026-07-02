// High-level orchestration: branch detection + store routing + CONTEXT.md
// refresh in one call. Used by the MCP tools and the /context-update route.

import type { SynthraPaths } from "../shared/paths.js";
import {
  currentBranch,
  defaultBranch,
  resolveBranchPaths,
  type BranchScopedPaths,
} from "./branches.js";
import { deriveContextMd, writeContextMd } from "./context-md.js";
import {
  appendEntry,
  readEntries,
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
  await appendEntry(active.paths.contextStore, entry);

  // Refresh CONTEXT.md so the narrative stays in sync with the structured store.
  const entries = await readEntries(active.paths.contextStore);
  const md = deriveContextMd(entries, active.branch);
  await writeContextMd(active.paths.contextMd, md);

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
}

export async function recallEntries(
  paths: SynthraPaths,
  input: RecallInput = {},
): Promise<RecallResult> {
  const active = await resolveActiveBranch(paths, input.branch);
  let entries = await readEntries(active.paths.contextStore);
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
  const entries = await readEntries(active.paths.contextStore);
  const md = deriveContextMd(entries, active.branch);
  await writeContextMd(active.paths.contextMd, md);
  return {
    branch: active.branch,
    path: active.paths.contextMd,
    entriesSeen: entries.length,
  };
}
