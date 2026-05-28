// Test ↔ source co-retrieval. Given a source file, returns the test files
// linked to it via `tests` edges in the graph (foo.test.ts → foo.ts).

import type { FileNode, GraphSchema } from "../graph/types.js";

export function findTestsForFile(graph: GraphSchema, file: FileNode): FileNode[] {
  // tests edges run from test file → source file
  const fileNodesById = new Map<string, FileNode>();
  for (const n of graph.nodes) {
    if (n.kind === "file") fileNodesById.set(n.id, n);
  }

  const out: FileNode[] = [];
  for (const e of graph.edges) {
    if (e.kind !== "tests" || e.to !== file.id) continue;
    const testFile = fileNodesById.get(e.from);
    if (testFile && !out.includes(testFile)) out.push(testFile);
  }
  return out;
}
