// Tests for buildSymbolIndex.

import { describe, it, expect } from "vitest";

import { buildCallEdges, buildGraph, buildSymbolIndex } from "../src/scanner/extract.js";
import { SCHEMA_VERSION } from "../src/graph/types.js";
import type { GraphSchema, SymbolNode } from "../src/graph/types.js";
import type { CallSite, ParsedFile } from "../src/scanner/parser.js";

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
    expect(index.getUser).toEqual([
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

function symN(file: string, name: string, start: number, end: number): SymbolNode {
  return {
    id: `symbol:${file}::${name}:${start}`,
    kind: "symbol",
    symbol_kind: "function",
    name,
    file,
    start_line: start,
    end_line: end,
    signature: `${name}()`,
  };
}

function callEdges(
  symsByFile: Record<string, SymbolNode[]>,
  callsByFile: Record<string, CallSite[]>,
) {
  return buildCallEdges(new Map(Object.entries(symsByFile)), new Map(Object.entries(callsByFile)));
}

describe("buildCallEdges (name-based call resolution)", () => {
  it("resolves an intra-file call to the local symbol", () => {
    const a = [symN("a.ts", "caller", 1, 10), symN("a.ts", "target", 12, 20)];
    const edges = callEdges({ "a.ts": a }, { "a.ts": [{ callee: "target", line: 5 }] });
    expect(edges).toEqual([
      { from: "symbol:a.ts::caller:1", to: "symbol:a.ts::target:12", kind: "calls" },
    ]);
  });

  it("resolves a unique cross-file callee", () => {
    const a = [symN("a.ts", "caller", 1, 10)];
    const b = [symN("b.ts", "target", 1, 5)];
    const edges = callEdges({ "a.ts": a, "b.ts": b }, { "a.ts": [{ callee: "target", line: 5 }] });
    expect(edges).toEqual([
      { from: "symbol:a.ts::caller:1", to: "symbol:b.ts::target:1", kind: "calls" },
    ]);
  });

  it("prefers the same-file symbol over a cross-file one of the same name", () => {
    const a = [symN("a.ts", "caller", 1, 10), symN("a.ts", "target", 12, 20)];
    const b = [symN("b.ts", "target", 1, 5)];
    const edges = callEdges({ "a.ts": a, "b.ts": b }, { "a.ts": [{ callee: "target", line: 5 }] });
    expect(edges[0]?.to).toBe("symbol:a.ts::target:12");
  });

  it("skips an ambiguous cross-file callee (>1 repo-wide)", () => {
    const a = [symN("a.ts", "caller", 1, 10)];
    const b = [symN("b.ts", "target", 1, 5)];
    const c = [symN("c.ts", "target", 1, 5)];
    const edges = callEdges(
      { "a.ts": a, "b.ts": b, "c.ts": c },
      { "a.ts": [{ callee: "target", line: 5 }] },
    );
    expect(edges).toEqual([]);
  });

  it("skips an external/builtin callee (0 matches)", () => {
    const a = [symN("a.ts", "caller", 1, 10)];
    expect(callEdges({ "a.ts": a }, { "a.ts": [{ callee: "console", line: 5 }] })).toEqual([]);
  });

  it("skips a call with no enclosing symbol (top-level)", () => {
    const a = [symN("a.ts", "caller", 1, 10), symN("a.ts", "target", 12, 20)];
    expect(callEdges({ "a.ts": a }, { "a.ts": [{ callee: "target", line: 50 }] })).toEqual([]);
  });

  it("skips a recursion self-edge", () => {
    const a = [symN("a.ts", "caller", 1, 10)];
    expect(callEdges({ "a.ts": a }, { "a.ts": [{ callee: "caller", line: 5 }] })).toEqual([]);
  });

  it("dedupes repeated calls from the same caller", () => {
    const a = [symN("a.ts", "caller", 1, 10), symN("a.ts", "target", 12, 20)];
    const edges = callEdges(
      { "a.ts": a },
      {
        "a.ts": [
          { callee: "target", line: 5 },
          { callee: "target", line: 6 },
        ],
      },
    );
    expect(edges).toHaveLength(1);
  });
});

describe("buildGraph — calls edges end to end", () => {
  it("emits a symbol→symbol calls edge from a populated ParsedFile.calls", async () => {
    const pf = (
      relPath: string,
      symbols: ParsedFile["symbols"],
      calls: CallSite[],
    ): ParsedFile => ({
      file: {
        absPath: `/${relPath}`,
        relPath,
        ext: relPath.slice(relPath.lastIndexOf(".")),
        size: 1,
      },
      source: "",
      symbols,
      imports: [],
      calls,
    });
    const a = pf(
      "a.ts",
      [{ name: "caller", kind: "function", startLine: 1, endLine: 10, signature: "caller()" }],
      [{ callee: "target", line: 5 }],
    );
    const b = pf(
      "b.ts",
      [{ name: "target", kind: "function", startLine: 1, endLine: 5, signature: "target()" }],
      [],
    );
    const graph = await buildGraph(".", [a, b]);
    expect(graph.edges).toContainEqual({
      from: "symbol:a.ts::caller:1",
      to: "symbol:b.ts::target:1",
      kind: "calls",
    });
  });
});
