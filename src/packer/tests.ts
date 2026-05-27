// Test ↔ source co-retrieval. Given a source file (e.g., src/auth/login.ts),
// finds matching test files (login.test.ts, login.spec.ts, __tests__/login.ts, etc.).
// Improvement #5.
// TODO: M2

import type { FileNode, GraphSchema } from "../graph/types.js";

export function findTestsForFile(_graph: GraphSchema, _file: FileNode): FileNode[] {
  throw new Error("Synthra: findTestsForFile not yet implemented (M2)");
}
