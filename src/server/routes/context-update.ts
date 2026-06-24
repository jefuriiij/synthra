// POST /context-update — Stop hook calls this at session end.
// 1. Re-renders CONTEXT.md from the branch-scoped store so the narrative stays
//    in sync with the structured entries that landed during the session.
// 2. Captures a session snapshot (git diff since last session + files touched +
//    open decisions/next-steps) to .synthra-graph/session.json, which the next
//    SessionStart primer reads to build a "Since you were last here" digest.
// Transcript-mining for new entries (auto "we decided X" → store) is deferred.

import { getCommitsSince, getHeadSha } from "../../memory/git-snapshot.js";
import { recallEntries, refreshContextMd, resolveActiveBranch } from "../../memory/index.js";
import {
  readSession,
  writeSession,
  SESSION_SCHEMA_VERSION,
  type SessionState,
} from "../../memory/session.js";
import type { ServerContext } from "../context.js";
import { getRegisteredEdits } from "../mcp.js";

export interface ContextUpdateRequest {
  transcript_path?: string;
  branch?: string;
}

export interface ContextUpdateResponse {
  updated: boolean;
  branch: string;
  path: string;
  entries: number;
}

// Window for "files the human touched this session" harvested from the activity
// ring at Stop. Generous — a session can be long, and the ring is bounded anyway.
const TOUCHED_WINDOW_MS = 24 * 60 * 60 * 1000;

async function captureSnapshot(ctx: ServerContext, branchOverride?: string): Promise<void> {
  const active = await resolveActiveBranch(ctx.paths, branchOverride);

  const [tasks, decisions, next] = await Promise.all([
    recallEntries(ctx.paths, { kind: "task", branch: active.branch, limit: 1 }),
    recallEntries(ctx.paths, { kind: "decision", branch: active.branch, limit: 3 }),
    recallEntries(ctx.paths, { kind: "next", branch: active.branch, limit: 3 }),
  ]);

  // Files touched this session: AI-registered edits ∪ recent human saves.
  const touched = new Set<string>(getRegisteredEdits());
  for (const p of ctx.activity.recentFilePaths(TOUCHED_WINDOW_MS)) touched.add(p);

  // Commits since the previous snapshot (or the most recent few on first run).
  const prev = await readSession(ctx.paths.sessionState);
  const recentCommits = await getCommitsSince(ctx.paths.projectRoot, prev?.endedAt ?? "");
  // Baseline for the next session's "changed symbols" digest.
  const headSha = await getHeadSha(ctx.paths.projectRoot);

  const snapshot: SessionState = {
    schema_version: SESSION_SCHEMA_VERSION,
    endedAt: new Date().toISOString(),
    branch: active.branch,
    filesTouched: Array.from(touched),
    recentCommits,
    summary: {
      tasks: tasks.entries.map((e) => e.content),
      decisions: decisions.entries.map((e) => e.content),
      next: next.entries.map((e) => e.content),
    },
    headSha,
  };
  await writeSession(ctx.paths.sessionState, snapshot);
}

export async function handleContextUpdate(
  req: ContextUpdateRequest,
  ctx: ServerContext,
): Promise<ContextUpdateResponse> {
  const r = await refreshContextMd(ctx.paths, req?.branch);

  // Best-effort: a snapshot failure (no git, unwritable disk) must never break
  // the CONTEXT.md refresh that downstream tooling relies on.
  try {
    await captureSnapshot(ctx, req?.branch);
  } catch {
    // ignore — the resume digest just falls back to the legacy primer next time.
  }

  return {
    updated: true,
    branch: r.branch,
    path: r.path,
    entries: r.entriesSeen,
  };
}
