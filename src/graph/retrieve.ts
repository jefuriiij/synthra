// Query-time retrieval. Given a natural-language query (or a symbol name),
// returns a ranked list of FileNodes.
// TODO: M2

import type { FileNode, GraphSchema } from "./types.js";

export interface RetrievalResult {
  files: FileNode[];
  confidence: "high" | "medium" | "low";
  reason: string;
}

export async function retrieve(_graph: GraphSchema, _query: string): Promise<RetrievalResult> {
  throw new Error("Synthra: retrieve not yet implemented (M2)");
}
