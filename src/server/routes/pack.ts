// POST /pack { query, maxTokens? } → ContextPack JSON.
// Runs retrieve → pack against the in-memory graph.

import { retrieve } from "../../graph/retrieve.js";
import { scoreFiles } from "../../graph/rank.js";
import { pack, type ContextPack } from "../../packer/index.js";
import type { ServerContext } from "../context.js";

export interface PackRequest {
  query: string;
  maxTokens?: number;
  includeTests?: boolean;
}

export interface PackResponse extends ContextPack {
  query: string;
  confidence: "high" | "medium" | "low";
  retrievalReason: string;
}

export async function handlePack(req: PackRequest, ctx: ServerContext): Promise<PackResponse> {
  if (!req?.query || typeof req.query !== "string") {
    throw new Error("pack: 'query' (string) is required");
  }

  const recentlyEditedPaths = ctx.activity.recentFilePaths(15 * 60 * 1000);
  const usageScores = ctx.learn?.effectiveScores();
  const retrieval = await retrieve(ctx.graph, req.query, { recentlyEditedPaths, usageScores });

  // Surface per-file scoring rationale in the rendered pack.
  const allFiles = ctx.graph.nodes.filter((n) => n.kind === "file");
  const scored = scoreFiles({
    candidates: allFiles as Parameters<typeof scoreFiles>[0]["candidates"],
    query: req.query,
    graph: ctx.graph,
    recentlyEditedPaths,
    usageScores,
  });
  const reasons = new Map<string, string>();
  for (const s of scored) {
    if (s.reasons.length) reasons.set(s.file.path, s.reasons.join(","));
  }

  const result = await pack(retrieval.files, {
    query: req.query,
    graph: ctx.graph,
    budgetTokens: req.maxTokens,
    includeTests: req.includeTests,
    reasons,
  });

  return {
    ...result,
    query: req.query,
    confidence: retrieval.confidence,
    retrievalReason: retrieval.reason,
  };
}
