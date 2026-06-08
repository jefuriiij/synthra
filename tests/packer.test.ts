// Context-packer tests: signatures + query-relevant inline bodies within a
// char budget, test co-retrieval, and truncation (both whole-file budget and
// per-body caps).

import { describe, it, expect } from "vitest";

import { pack } from "../src/packer/index.js";
import type { GraphSchema, SymbolKind } from "../src/graph/types.js";

function fileNode(path: string, content: string, keywords: string[] = []) {
  return {
    id: `file:${path}`,
    kind: "file" as const,
    path,
    ext: path.slice(path.lastIndexOf(".")),
    size: content.length,
    keywords,
    content,
    summary: "",
    file_hash: "x",
  };
}

function symNode(
  file: string,
  name: string,
  kind: SymbolKind,
  start: number,
  end: number,
  signature: string,
) {
  return {
    id: `sym:${file}:${name}`,
    kind: "symbol" as const,
    symbol_kind: kind,
    name,
    file,
    start_line: start,
    end_line: end,
    signature,
  };
}

function graphOf(nodes: GraphSchema["nodes"], edges: GraphSchema["edges"] = []): GraphSchema {
  const files = nodes.filter((n) => n.kind === "file");
  const syms = nodes.filter((n) => n.kind === "symbol");
  return {
    root: ".",
    node_count: nodes.length,
    edge_count: edges.length,
    file_count: files.length,
    symbol_count: syms.length,
    nodes,
    edges,
    generated_at: "1970-01-01T00:00:00.000Z",
    schema_version: 1,
  };
}

describe("pack", () => {
  it("packs signatures + the query-relevant inline body within budget", async () => {
    const content = [
      "export function login(user) {",
      '  return "ok:" + user;',
      "}",
      "export function helper() {",
      "  return 1;",
      "}",
    ].join("\n");
    const file = fileNode("src/auth.ts", content);
    const graph = graphOf([
      file,
      symNode("src/auth.ts", "login", "function", 1, 3, "export function login(user)"),
      symNode("src/auth.ts", "helper", "function", 4, 6, "export function helper()"),
    ]);

    const result = await pack([file], { query: "login", graph, budgetTokens: 4000 });

    expect(result.filesUsed).toEqual(["src/auth.ts"]);
    expect(result.truncated).toBe(false);
    // Both signatures are listed…
    expect(result.text).toContain("function login(user)");
    expect(result.text).toContain("function helper()");
    // …but only the query-relevant body is inlined.
    expect(result.text).toContain('return "ok:" + user;');
    expect(result.text).not.toContain("return 1;");
    expect(result.tokenEstimate).toBe(Math.ceil(result.text.length / 4));
  });

  it("co-retrieves linked test files (and skips them when includeTests is false)", async () => {
    const src = fileNode("src/foo.ts", "export function foo() {\n  return 1;\n}\n");
    const testFile = fileNode("src/foo.test.ts", "test('foo', () => {});\n");
    const graph = graphOf(
      [src, testFile, symNode("src/foo.ts", "foo", "function", 1, 3, "export function foo()")],
      [{ from: "file:src/foo.test.ts", to: "file:src/foo.ts", kind: "tests" }],
    );

    const withTests = await pack([src], { query: "foo", graph, includeTests: true });
    expect(withTests.testsCoRetrieved).toContain("src/foo.test.ts");

    const without = await pack([src], { query: "foo", graph, includeTests: false });
    expect(without.testsCoRetrieved).toEqual([]);
  });

  it("respects the whole-file budget and per-body truncation limits", async () => {
    // (a) a tight total budget packs fewer files than requested + flags truncated
    const f1 = fileNode("src/one.ts", "export function one() {\n  return 1;\n}\n");
    const f2 = fileNode("src/two.ts", "export function two() {\n  return 2;\n}\n");
    const g2 = graphOf([
      f1,
      f2,
      symNode("src/one.ts", "one", "function", 1, 3, "export function one()"),
      symNode("src/two.ts", "two", "function", 1, 3, "export function two()"),
    ]);
    const tight = await pack([f1, f2], { query: "one two", graph: g2, budgetTokens: 90 });
    expect(tight.truncated).toBe(true);
    expect(tight.filesUsed.length).toBeLessThan(2);

    // (b) an oversized body is truncated, not inlined whole
    const bigBody = `export function big() {\n${"  const x = 0;\n".repeat(400)}}\n`;
    const big = fileNode("src/big.ts", bigBody);
    const endLine = bigBody.split("\n").length;
    const gBig = graphOf([
      big,
      symNode("src/big.ts", "big", "function", 1, endLine, "export function big()"),
    ]);
    const packed = await pack([big], { query: "big", graph: gBig, budgetTokens: 4000 });
    expect(packed.text).toContain("truncated");
    expect(packed.text.length).toBeLessThan(bigBody.length);
  });
});
