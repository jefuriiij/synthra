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

import { handleGate } from "../src/server/routes/gate.js";
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
