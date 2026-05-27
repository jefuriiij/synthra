// Compresses a list of retrieved files into a ~4K-token structured
// context pack: function signatures + top inline bodies + dependency edges.
// TODO: M2

import type { FileNode } from "../graph/types.js";

export interface PackOptions {
  budgetTokens: number;
  inlineBodyRatio: number;
  includeTests: boolean;
}

export interface ContextPack {
  text: string;
  tokenEstimate: number;
  filesUsed: string[];
  testsCoRetrieved: string[];
}

export async function pack(_files: FileNode[], _opts: PackOptions): Promise<ContextPack> {
  throw new Error("Synthra: pack not yet implemented (M2)");
}
