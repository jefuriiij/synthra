// GET /prime — SessionStart and PreCompact hooks call this. Returns the
// priming text Claude sees at session start.
//
// For M2 we return a minimal primer derived from the graph (file count + a
// short top-level summary). M3 layers in CONTEXT.md narrative + recent
// stored decisions.

import type { ServerContext } from "../context.js";

export interface PrimeResponse {
  primer: string;
  port: number;
}

export async function handlePrime(ctx: ServerContext, port: number): Promise<PrimeResponse> {
  const g = ctx.graph;
  const fileCount = g.file_count;
  const symbolCount = g.symbol_count;

  const primer =
    `Synthra context loaded for ${g.root}.\n` +
    `${fileCount} files indexed, ${symbolCount} symbols. ` +
    `Prefer the graph_* MCP tools over Grep/Glob for navigation.\n` +
    `(Full primer wired in M3.)`;

  return { primer, port };
}
