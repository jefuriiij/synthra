// Scoring for retrieved files. Combines:
//   - keyword overlap with query
//   - import-graph distance from session-known files
//   - recency boost from activity log (M5)
// TODO: M2 (keyword + imports); M5 (activity boost)

import type { FileNode } from "./types.js";

export interface RankInputs {
  candidates: FileNode[];
  query: string;
  recentlyEditedPaths?: string[];
  sessionKnownPaths?: string[];
}

export function rank(_inputs: RankInputs): FileNode[] {
  throw new Error("Synthra: rank not yet implemented (M2)");
}
