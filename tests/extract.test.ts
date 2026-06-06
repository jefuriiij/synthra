// Tests for buildSymbolIndex.

import { describe, it, expect } from "vitest";

import { buildGraph, buildSymbolIndex } from "../src/scanner/extract.js";
import { SCHEMA_VERSION } from "../src/graph/types.js";
import type { GraphSchema, SymbolNode } from "../src/graph/types.js";

function symbol(name: string, line: number): SymbolNode {
  return {
    id: `sym:${name}:${line}`,
    kind: "symbol",
    symbol_kind: "method",
    name,
    file: "lib/model.dart",
    start_line: line,
    end_line: line + 1,
    signature: `${name}()`,
  };
}

function graphOf(...nodes: SymbolNode[]): GraphSchema {
  return {
    root: ".",
    node_count: nodes.length,
    edge_count: 0,
    file_count: 0,
    symbol_count: nodes.length,
    nodes,
    edges: [],
    generated_at: "1970-01-01T00:00:00.000Z",
    schema_version: 1,
  };
}

describe("buildSymbolIndex", () => {
  it("indexes plain symbol names", () => {
    const index = buildSymbolIndex(graphOf(symbol("getUser", 10), symbol("getUser", 42)));
    expect(index["getUser"]).toEqual([
      { file: "lib/model.dart", line: 10, kind: "method" },
      { file: "lib/model.dart", line: 42, kind: "method" },
    ]);
  });

  // Regression: Dart classes routinely override toString(), and "toString",
  // "constructor", "valueOf", etc. resolve to Object.prototype members on a
  // plain {}. The old code did `out[name] ?? (out[name] = [])`, which got the
  // inherited function (truthy, so ?? skipped) and then crashed on .push.
  it("handles symbol names that collide with Object.prototype members", () => {
    const reserved = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"];
    const index = buildSymbolIndex(graphOf(...reserved.map((n, i) => symbol(n, i + 1))));
    for (const [i, name] of reserved.entries()) {
      expect(index[name]).toEqual([{ file: "lib/model.dart", line: i + 1, kind: "method" }]);
    }
  });
});

describe("buildGraph schema_version (#8)", () => {
  it("stamps the current SCHEMA_VERSION on the graph", async () => {
    const graph = await buildGraph(".", []);
    expect(graph.schema_version).toBe(SCHEMA_VERSION);
  });
});
