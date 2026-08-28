// Ranking tests.

import { describe, it, expect } from "vitest";

import { looksVendored, scoreFiles } from "../src/graph/rank.js";
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

function mkFileNode(path: string, keywords: string[]): FileNode {
  return {
    id: `file:${path}`,
    kind: "file",
    path,
    ext: path.slice(path.lastIndexOf(".")),
    size: 1,
    keywords,
    content: "",
    summary: "",
    file_hash: "x",
  };
}

function mkGraph(
  files: FileNode[],
  importEdges: Array<{ from: string; to: string }> = [],
): GraphSchema {
  return {
    root: ".",
    node_count: files.length,
    edge_count: importEdges.length,
    file_count: files.length,
    symbol_count: 0,
    nodes: files,
    edges: importEdges.map((e) => ({
      from: `file:${e.from}`,
      to: `file:${e.to}`,
      kind: "imports" as const,
    })),
    generated_at: "1970-01-01T00:00:00.000Z",
    schema_version: 1,
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
});

describe("scoreFiles — session seeds (#14)", () => {
  it("boosts recently-edited files (+5 'seed' boost outranks an equal keyword match)", () => {
    const a = mkFileNode("src/a.ts", ["auth"]);
    const b = mkFileNode("src/b.ts", ["auth"]);
    const graph = mkGraph([a, b]);
    const scored = scoreFiles({
      candidates: [a, b],
      query: "auth",
      graph,
      recentlyEditedPaths: ["src/b.ts"],
    });
    expect(scored[0]?.file.path).toBe("src/b.ts");
    expect(scored[0]?.reasons).toContain("seed");
  });

  it("boosts files reachable from session-known files via imports", () => {
    // a.ts is session-known (seed) and imports dep.ts; dep.ts has no keyword
    // match but should get the 1-hop import-adjacency boost.
    const a = mkFileNode("src/a.ts", []);
    const dep = mkFileNode("src/dep.ts", []);
    const graph = mkGraph([a, dep], [{ from: "src/a.ts", to: "src/dep.ts" }]);
    const scored = scoreFiles({
      candidates: [a, dep],
      query: "zzz",
      graph,
      sessionKnownPaths: ["src/a.ts"],
    });
    const depScored = scored.find((s) => s.file.path === "src/dep.ts");
    expect(depScored?.score).toBeGreaterThan(0);
    expect(depScored?.reasons).toContain("imp-adj");
  });
});

describe("scoreFiles — usage-learning boost", () => {
  it("ranks a higher-usage file above an equal-keyword peer (used reason)", () => {
    const a = mkFileNode("src/a.ts", ["auth"]);
    const b = mkFileNode("src/b.ts", ["auth"]);
    const graph = mkGraph([a, b]);
    const scored = scoreFiles({
      candidates: [a, b],
      query: "auth",
      graph,
      usageScores: new Map([["src/b.ts", 10]]),
    });
    expect(scored[0]?.file.path).toBe("src/b.ts");
    expect(scored[0]?.reasons.some((r) => r.startsWith("used"))).toBe(true);
  });

  it("never promotes a score-0 (non-matching) file, even with huge usage", () => {
    const a = mkFileNode("src/a.ts", ["auth"]); // matches the query
    const z = mkFileNode("src/z.ts", ["zzz"]); // no match, no import edge
    const graph = mkGraph([a, z]);
    const scored = scoreFiles({
      candidates: [a, z],
      query: "auth",
      graph,
      usageScores: new Map([["src/z.ts", 999]]),
    });
    const z2 = scored.find((s) => s.file.path === "src/z.ts");
    expect(z2?.score).toBe(0);
    expect(z2?.reasons.some((r) => r.startsWith("used"))).toBe(false);
  });

  it("a maxed usage boost cannot outrank a freshly seeded file (+5)", () => {
    const seeded = mkFileNode("src/seeded.ts", ["auth"]);
    const hot = mkFileNode("src/hot.ts", ["auth"]);
    const graph = mkGraph([seeded, hot]);
    const scored = scoreFiles({
      candidates: [seeded, hot],
      query: "auth",
      graph,
      recentlyEditedPaths: ["src/seeded.ts"],
      usageScores: new Map([["src/hot.ts", 1000]]),
    });
    expect(scored[0]?.file.path).toBe("src/seeded.ts");
  });

  it("omitting usageScores adds no boost (deterministic ranker unchanged)", () => {
    const a = mkFileNode("src/a.ts", ["auth"]);
    const graph = mkGraph([a]);
    const [top] = scoreFiles({ candidates: [a], query: "auth", graph });
    expect(top.score).toBe(2); // keyword +2 only
    expect(top.reasons.some((r) => r.startsWith("used"))).toBe(false);
  });
});

describe("scoreFiles — IDF keyword weighting", () => {
  it("ranks a match on a rarer query term above a match on a common one", () => {
    // "common" appears in 4 of 5 files; "rare" in 1. Two files each match only
    // one of the two query terms — the rare-term file should rank higher.
    const c1 = mkFileNode("src/c1.ts", ["common"]);
    const c2 = mkFileNode("src/c2.ts", ["common"]);
    const c3 = mkFileNode("src/c3.ts", ["common"]);
    const commonMatch = mkFileNode("src/cm.ts", ["common"]);
    const rareMatch = mkFileNode("src/r.ts", ["rare"]);
    const candidates = [c1, c2, c3, commonMatch, rareMatch];
    const graph = mkGraph(candidates);

    const scored = scoreFiles({ candidates, query: "rare common", graph });
    const r = scored.find((s) => s.file.path === "src/r.ts");
    const cm = scored.find((s) => s.file.path === "src/cm.ts");
    expect((r?.score ?? 0) > (cm?.score ?? 0)).toBe(true);
  });

  it("preserves the legacy magnitude for a typical single-term match (no calibration shift)", () => {
    const a = mkFileNode("src/a.ts", ["auth"]);
    const b = mkFileNode("src/b.ts", ["other"]);
    const graph = mkGraph([a, b]);
    const [top] = scoreFiles({ candidates: [a, b], query: "auth", graph });
    expect(top.file.path).toBe("src/a.ts");
    expect(top.score).toBe(2); // refIdf == idf(auth) → weight exactly KW_BASE_WEIGHT
  });
});

// v0.28 — vendored code answered almost any token by accident. Six dogfood
// sessions running, a CSS-class search in a known page was redirected to gsap,
// bootstrap or fslightbox internals.
describe("looksVendored", () => {
  it("spots third-party directories", () => {
    expect(looksVendored("assets/vendor/gsap.js")).toBe(true);
    expect(looksVendored("theme/vendors/isotope.js")).toBe(true);
    expect(looksVendored("js/gsap-public/all.js")).toBe(true);
    expect(looksVendored("bower_components/jquery/x.js")).toBe(true);
  });

  it("spots shipped bundles by filename", () => {
    expect(looksVendored("js/app.min.js")).toBe(true);
    expect(looksVendored("js/site.bundle.js")).toBe(true);
    expect(looksVendored("js/theme-min.css")).toBe(true);
  });

  it("leaves your own source alone", () => {
    // lib/ and assets/ are deliberately NOT vendor markers — plenty of
    // projects keep first-party code there.
    expect(looksVendored("src/lib/socket.ts")).toBe(false);
    expect(looksVendored("assets/js/main.js")).toBe(false);
    expect(looksVendored("pages/home-v3.html")).toBe(false);
    expect(looksVendored("src/components/Bundle.svelte")).toBe(false);
  });
});
