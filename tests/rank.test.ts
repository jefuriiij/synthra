// Ranking tests.

import { describe, it, expect } from "vitest";

import { scoreFiles } from "../src/graph/rank.js";
import type { FileNode, GraphSchema, SymbolNode } from "../src/graph/types.js";

function graphWith(symbolName: string): { graph: GraphSchema; candidates: FileNode[] } {
  const file: FileNode = {
    id: "file:src/auth.ts",
    kind: "file",
    path: "src/auth.ts",
    ext: ".ts",
    size: 100,
    keywords: ["auth", "service", "login"],
    content: "",
    summary: "",
    file_hash: "x",
  };
  const sym: SymbolNode = {
    id: "sym:src/auth.ts:" + symbolName,
    kind: "symbol",
    symbol_kind: "class",
    name: symbolName,
    file: "src/auth.ts",
    start_line: 1,
    end_line: 10,
    signature: `class ${symbolName}`,
  };
  return {
    graph: {
      root: "/p",
      node_count: 2,
      edge_count: 0,
      file_count: 1,
      symbol_count: 1,
      nodes: [file, sym],
      edges: [],
      generated_at: "2026-06-06T00:00:00.000Z",
      schema_version: 1,
    },
    candidates: [file],
  };
}

describe("scoreFiles — symbol-hit tracking", () => {
  it("counts an exact symbol-name match in exactSym", () => {
    const { graph, candidates } = graphWith("AuthService");
    const [top] = scoreFiles({ candidates, query: "AuthService", graph });
    expect(top.exactSym).toBeGreaterThan(0);
    expect(top.symHits).toBeGreaterThanOrEqual(3);
  });

  it("does NOT count a keyword-only / partial match as exactSym", () => {
    // "login" matches the file keyword but no symbol name exactly.
    const { graph, candidates } = graphWith("AuthService");
    const [top] = scoreFiles({ candidates, query: "login", graph });
    expect(top.score).toBeGreaterThan(0); // keyword hit still scores
    expect(top.exactSym).toBe(0); // but it's not an exact symbol match
  });

  it.todo("boosts files reachable from session-known files via imports");
  it.todo("boosts recently-edited files");
});
