// Picks the top N most-relevant function bodies from a FileNode
// and inlines them in the context pack.
// TODO: M2

import type { FileNode } from "../graph/types.js";

export interface InlineSelection {
  text: string;
  tokenEstimate: number;
  functionsInlined: string[];
}

export function selectInlineBodies(
  _f: FileNode,
  _query: string,
  _tokenBudget: number,
): InlineSelection {
  throw new Error("Synthra: selectInlineBodies not yet implemented (M2)");
}
