// Gate (the Moat) tests. The decision corpus is drawn from REAL Grep/Glob
// queries observed in the dogfood log:
//   - "should ALLOW" = blocks that were wasted (graph had no symbol to offer,
//     so Claude fell back to grep/Read anyway).
//   - "should BLOCK" = good blocks (the query names a real indexed symbol).
// Two guards added in v0.1.20: a query-shape pre-filter (markup/CSS/attrs) and
// a symbol-hit requirement (only block when an exact symbol name matched).

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBlockHint, handleGate } from "../src/server/routes/gate.js";
import type { RetrievalResult } from "../src/graph/retrieve.js";
import type { ServerContext } from "../src/server/context.js";
import type {
  FileNode,
  GraphNode,
  GraphSchema,
  SymbolKind,
  SymbolNode,
} from "../src/graph/types.js";

interface FileSpec {
  path: string;
  keywords: string[];
  symbols?: string[];
}

function buildGraph(specs: FileSpec[]): GraphSchema {
  const nodes: GraphNode[] = [];
  let symbolCount = 0;
  for (const s of specs) {
    const fileNode: FileNode = {
      id: `file:${s.path}`,
      kind: "file",
      path: s.path,
      ext: s.path.slice(s.path.lastIndexOf(".")),
      size: 100,
      keywords: s.keywords,
      content: "",
      summary: "",
      file_hash: "x",
    };
    nodes.push(fileNode);
    for (const name of s.symbols ?? []) {
      const sym: SymbolNode = {
        id: `sym:${s.path}:${name}`,
        kind: "symbol",
        symbol_kind: "function" as SymbolKind,
        name,
        file: s.path,
        start_line: 1,
        end_line: 5,
        signature: `${name}()`,
      };
      nodes.push(sym);
      symbolCount += 1;
    }
  }
  const fileCount = specs.length;
  return {
    root: "/proj",
    node_count: nodes.length,
    edge_count: 0,
    file_count: fileCount,
    symbol_count: symbolCount,
    nodes,
    edges: [],
    generated_at: "2026-06-06T00:00:00.000Z",
    schema_version: 1,
  };
}

// Fixture mirrors the files/symbols behind the dogfood block-set.
const GRAPH = buildGraph([
  {
    path: "src/lib/server/hs-fetch.ts",
    keywords: ["fetch", "retry", "rate", "limit", "hs"],
    symbols: ["fetchWith429Retry", "isRateLimit", "retry5xx"],
  },
  {
    path: "src/routes/data/+server.ts",
    keywords: ["data", "server", "rows", "table", "max"],
    symbols: ["MAX_ROWS_PER_TABLE"],
  },
  {
    path: "src/lib/pin.ts",
    keywords: ["pin", "verify", "vault"],
    symbols: ["verifyPin", "verifyOrSetPin"],
  },
  {
    path: "src/lib/socket.ts",
    keywords: ["socket", "auth", "secret"],
    symbols: ["SOCKET_AUTH_SECRET", "initSocket"],
  },
  {
    path: "src/lib/sandbox/seed.ts",
    keywords: ["seed", "credentials", "sandbox"],
    symbols: ["seedCredentials"],
  },
  {
    // symbol name also appears in the path → exercises recent-activity overlap.
    path: "src/lib/login.ts",
    keywords: ["login", "auth"],
    symbols: ["login"],
  },
  {
    // keyword "login" but NO "login" in the path → exercises content-keyword
    // recency relaxation (#3): a recent touch here relaxes a `login` block.
    path: "src/lib/session.ts",
    keywords: ["login", "auth", "session"],
    symbols: ["createSession"],
  },
  {
    // path/keyword match but NO symbol the query names → exercises Guard 2.
    path: "src/routes/app/runs/[id]/+page.svelte",
    keywords: ["app", "runs", "id", "run", "detail", "page"],
    symbols: ["RunDetail"],
  },
]);

function ctx(recentPaths: string[] = []): ServerContext {
  return {
    paths: { gateLog: join(tmpdir(), "syn-gate-test.log") },
    graph: GRAPH,
    symbolIndex: {},
    activity: { recentFilePaths: () => recentPaths },
  } as unknown as ServerContext;
}

async function grep(pattern: string, recentPaths: string[] = []): Promise<string> {
  const res = await handleGate({ tool_name: "Grep", tool_input: { pattern } }, ctx(recentPaths));
  return res.decision;
}

async function glob(pattern: string): Promise<string> {
  const res = await handleGate({ tool_name: "Glob", tool_input: { pattern } }, ctx());
  return res.decision;
}

describe("gate — should ALLOW (would have been wasted blocks)", () => {
  // Guard 1: markup / CSS / attribute / literal queries the graph can't answer.
  it.each([
    ['data-tour="[a-z-]+"', "HTML attribute"],
    ["^<div|class=|: 100%|height|position", "HTML tag + CSS value"],
    ["<svg|gwrap|clientWidth", "SVG tag"],
    ["\\.filter-bar\\b", "CSS class selector"],
    ["topbar|wrap|\\.content\\{|\\.gs\\{", "CSS rule braces"],
  ])("allows non-symbol query: %s (%s)", async (pattern) => {
    expect(await grep(pattern)).toBe("allow");
  });

  // Guard 2: path/keyword matched but no symbol the query names.
  it("allows a path-only Glob (app/runs/[id])", async () => {
    expect(await glob("app/runs/[id]")).toBe("allow");
  });

  it("allows a keyword-only Grep with no exact symbol match (rate limit)", async () => {
    expect(await grep("rate limit")).toBe("allow");
  });
});

describe("gate — should BLOCK (query names a real symbol)", () => {
  it.each([
    "fetchWith429Retry|isRateLimit|retry5xx|Retry-After",
    "MAX_ROWS_PER_TABLE",
    "verifyPin|verifyOrSetPin|changeP",
    "SOCKET_AUTH_SECRET|SOCKET\\s*=",
    "seedCredentials|hubspot_oauth|api_key|bearer",
  ])("blocks symbol query: %s", async (pattern) => {
    expect(await grep(pattern)).toBe("block");
  });
});

describe("gate — existing behavior preserved", () => {
  it("allows non-blockable tools", async () => {
    const res = await handleGate({ tool_name: "Read", tool_input: { file_path: "x.ts" } }, ctx());
    expect(res.decision).toBe("allow");
  });

  it("blocks an exact symbol query with no recent activity (login)", async () => {
    expect(await grep("login")).toBe("block");
  });

  it("allows that same symbol query when the human just touched a matching file", async () => {
    // recent-activity overlap relaxes even a real symbol block (path match).
    expect(await grep("login", ["src/lib/login.ts"])).toBe("allow");
  });
});

describe("gate — block reason carries the payload (v0.4.0)", () => {
  async function blockReason(pattern: string): Promise<string> {
    const res = await handleGate({ tool_name: "Grep", tool_input: { pattern } }, ctx());
    expect(res.decision).toBe("block");
    return res.reason ?? "";
  }

  it("includes a copy-pasteable namespaced graph_read target with file::symbol", async () => {
    const reason = await blockReason("login");
    expect(reason).toContain('mcp__synthra__graph_read("src/lib/login.ts::login")');
  });

  it("includes the symbol's signature line with its line number", async () => {
    const reason = await blockReason("login");
    expect(reason).toMatch(/L1: login\(\)/);
  });

  it("offers the full pack via namespaced graph_continue", async () => {
    const reason = await blockReason("login");
    expect(reason).toContain('mcp__synthra__graph_continue("login")');
  });

  it("never mentions a bare short tool name the agent could mis-ToolSearch", async () => {
    const reason = await blockReason("login");
    // every tool mention must be namespaced — `graph_read` only as mcp__synthra__graph_read
    expect(reason).not.toMatch(/(?<!mcp__synthra__)graph_(read|continue)/);
  });

  it("stays within the default hint budget", async () => {
    const reason = await blockReason("fetchWith429Retry|isRateLimit|retry5xx|Retry-After");
    expect(reason.length).toBeLessThanOrEqual(1200);
  });
});

describe("buildBlockHint (unit)", () => {
  function retrievalOf(
    graph: GraphSchema,
    paths: string[],
    confidence: RetrievalResult["confidence"] = "high",
  ): RetrievalResult {
    const byPath = new Map(
      graph.nodes.filter((n): n is FileNode => n.kind === "file").map((n) => [n.path, n]),
    );
    return {
      files: paths.map((p) => byPath.get(p) as FileNode),
      confidence,
      reason: "test",
      symbolMatched: true,
    };
  }

  it("picks the query-relevant symbol over an irrelevant one in the same file", () => {
    const hint = buildBlockHint("verifyPin", retrievalOf(GRAPH, ["src/lib/pin.ts"]), GRAPH, "Grep");
    expect(hint).toContain('graph_read("src/lib/pin.ts::verifyPin")');
    // verifyOrSetPin scores 0 for this query — not listed.
    expect(hint).not.toContain("verifyOrSetPin");
  });

  it("falls back to the file's first symbol when nothing scores", () => {
    const hint = buildBlockHint(
      "completely unrelated words",
      retrievalOf(GRAPH, ["src/lib/socket.ts"]),
      GRAPH,
      "Grep",
    );
    expect(hint).toContain('graph_read("src/lib/socket.ts::SOCKET_AUTH_SECRET")');
  });

  it("emits a path-only target for a file with no indexed symbols", () => {
    const g = buildGraph([
      { path: "docs/readme.md", keywords: ["readme"] },
      { path: "src/lib/login.ts", keywords: ["login"], symbols: ["login"] },
    ]);
    const hint = buildBlockHint(
      "login",
      retrievalOf(g, ["docs/readme.md", "src/lib/login.ts"]),
      g,
      "Grep",
    );
    expect(hint).toContain('mcp__synthra__graph_read("docs/readme.md")');
    expect(hint).toContain('mcp__synthra__graph_read("src/lib/login.ts::login")');
  });

  it("drops whole entries (never truncates mid-entry) when over budget", () => {
    const retrieval = retrievalOf(GRAPH, [
      "src/lib/login.ts",
      "src/lib/session.ts",
      "src/lib/pin.ts",
    ]);
    const full = buildBlockHint("login", retrieval, GRAPH, "Grep", 10_000);
    const firstEntryEnd = full.indexOf("\n•", full.indexOf("•") + 1);
    // budget that fits the header/footer + first entry but not the second
    const tight = buildBlockHint("login", retrieval, GRAPH, "Grep", firstEntryEnd + 80);
    const bullets = tight.match(/•/g) ?? [];
    expect(bullets.length).toBeGreaterThanOrEqual(1);
    expect(bullets.length).toBeLessThan((full.match(/•/g) ?? []).length);
    expect(tight).toContain('mcp__synthra__graph_continue("login")'); // footer intact
  });

  it("degenerate budget falls back to a namespaced path list", () => {
    const hint = buildBlockHint(
      "login",
      retrievalOf(GRAPH, ["src/lib/login.ts"]),
      GRAPH,
      "Grep",
      10,
    );
    expect(hint).toContain("top files: src/lib/login.ts");
    expect(hint).toContain("mcp__synthra__graph_continue");
  });
});

describe("gate — #3 content-keyword recency relaxation", () => {
  it("relaxes a symbol block when a recently-touched file's CONTENT matches (path doesn't)", async () => {
    // "login" is an exact symbol (would block). src/lib/session.ts has no
    // "login" in its path — only in its keywords. Pre-#3 this stayed blocked.
    expect(await grep("login", ["src/lib/session.ts"])).toBe("allow");
  });

  it("still blocks when the recently-touched file shares no path- or content-token", async () => {
    // socket.ts shares nothing with "login" (path or keywords) → no relax.
    expect(await grep("login", ["src/lib/socket.ts"])).toBe("block");
  });
});

describe("gate — guard lets styling/markup searches through (v0.5.0)", () => {
  it.each([
    ["var(--sidebar)|var(--surface)", "CSS custom properties"],
    ["generate|var(--ok)|#fff", "CSS var + hex color"],
    ["#0a0a0a", "hex color literal"],
    ["cw-feedback-context-label|cw-code-chip", "all-kebab class names"],
  ])("allows %s (%s)", async (pattern) => {
    expect(await grep(pattern)).toBe("allow");
  });

  it("still blocks a real symbol query that contains a hyphenated header alongside it", async () => {
    // "Retry-After" is kebab, but the query also names real symbols — not every
    // branch is kebab, so it must still block (regression guard for the over-allow).
    expect(await grep("fetchWith429Retry|isRateLimit|retry5xx|Retry-After")).toBe("block");
  });

  it("still blocks a real symbol query that merely contains a regex char-class range", async () => {
    // "[A-Z]" must be stripped before the kebab check, else "A-Z" reads as kebab.
    expect(await grep("fetchWith429Retry|[A-Z]x")).toBe("block");
  });
});
