// POST /context-update — Stop hook calls this at session end.
// For M4: re-renders CONTEXT.md from the branch-scoped store so the narrative
// stays in sync with the structured entries that landed during the session.
// Transcript-mining for new entries (auto "we decided X" → store) is v0.2.

import { refreshContextMd } from "../../memory/index.js";
import type { ServerContext } from "../context.js";

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

export async function handleContextUpdate(
  req: ContextUpdateRequest,
  ctx: ServerContext,
): Promise<ContextUpdateResponse> {
  const r = await refreshContextMd(ctx.paths, req?.branch);
  return {
    updated: true,
    branch: r.branch,
    path: r.path,
    entries: r.entriesSeen,
  };
}
