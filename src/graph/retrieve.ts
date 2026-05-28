// Query-time retrieval. Given a natural-language query (or a symbol name),
// returns a ranked list of FileNodes plus a confidence label.

import { scoreFiles, tokenizeQuery, type RankInputs } from "./rank.js";
import type { FileNode, GraphSchema } from "./types.js";

export interface RetrievalResult {
  files: FileNode[];
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface RetrieveOptions {
  topK?: number;
  recentlyEditedPaths?: string[];
  sessionKnownPaths?: string[];
}

export async function retrieve(
  graph: GraphSchema,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const topK = options.topK ?? 12;
  const qTokens = tokenizeQuery(query);

  const allFiles: FileNode[] = graph.nodes.filter(
    (n): n is FileNode => n.kind === "file",
  );

  if (allFiles.length === 0 || qTokens.length === 0) {
    return {
      files: [],
      confidence: "low",
      reason: qTokens.length === 0 ? "empty query" : "empty graph",
    };
  }

  const rankInputs: RankInputs = {
    candidates: allFiles,
    query,
    graph,
    recentlyEditedPaths: options.recentlyEditedPaths,
    sessionKnownPaths: options.sessionKnownPaths,
  };
  const scored = scoreFiles(rankInputs);
  const positive = scored.filter((s) => s.score > 0);

  if (positive.length === 0) {
    return {
      files: [],
      confidence: "low",
      reason: `no matches for ${JSON.stringify(qTokens)}`,
    };
  }

  const top = positive.slice(0, topK).map((s) => s.file);
  const topScore = positive[0]?.score ?? 0;
  const secondScore = positive[1]?.score ?? 0;

  // confidence: high = clear top match (2x next or only one hit)
  //             medium = several hits but no dominant one
  //             low = a few weak hits
  let confidence: "high" | "medium" | "low";
  if (positive.length === 1) confidence = "high";
  else if (topScore >= 6 && topScore >= secondScore * 2) confidence = "high";
  else if (topScore >= 3) confidence = "medium";
  else confidence = "low";

  const reasons = positive
    .slice(0, Math.min(3, top.length))
    .map((s) => `${s.file.path} (${s.reasons.join(",")})`)
    .join("; ");

  return {
    files: top,
    confidence,
    reason: `top: ${reasons}`,
  };
}
