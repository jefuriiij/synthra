// graph_read target resolution (#11) + per-file usage capture.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { FileNode, GraphSchema, SymbolNode } from "../src/graph/types.js";
import type { ServerContext } from "../src/server/context.js";
import {
  buildDepsFooter,
  buildTestsFooter,
  handleMcpRequest,
  resolveFileTarget,
} from "../src/server/mcp.js";
import { resolvePaths } from "../src/shared/paths.js";

function fileNode(path: string): FileNode {
  return {
    id: `file:${path}`,
    kind: "file",
    path,
    ext: path.slice(path.lastIndexOf(".")),
    size: 1,
    keywords: [],
    content: "",
    summary: "",
    file_hash: "x",
  };
}

function graphOf(...paths: string[]): GraphSchema {
  const nodes = paths.map(fileNode);
  return {
    root: ".",
    node_count: nodes.length,
    edge_count: 0,
    file_count: nodes.length,
    symbol_count: 0,
    nodes,
    edges: [],
    generated_at: "1970-01-01T00:00:00.000Z",
    schema_version: 1,
  };
}

const G = graphOf(
  "connectwarev2/api/ConnectwareApi/appsettings.json",
  "src/lib/socket.ts",
  "src/routes/data/+server.ts",
  "src/routes/admin/+server.ts",
);

describe("resolveFileTarget", () => {
  it("matches an exact path", () => {
    const r = resolveFileTarget(G, "src/lib/socket.ts");
    expect("node" in r && r.node.path).toBe("src/lib/socket.ts");
  });

  it("falls back to a unique basename suffix (the connectware case)", () => {
    const r = resolveFileTarget(G, "appsettings.json");
    expect("node" in r && r.node.path).toBe("connectwarev2/api/ConnectwareApi/appsettings.json");
  });

  it("falls back to a unique partial-path suffix", () => {
    const r = resolveFileTarget(G, "ConnectwareApi/appsettings.json");
    expect("node" in r && r.node.path).toBe("connectwarev2/api/ConnectwareApi/appsettings.json");
  });

  it("reports candidates when the suffix is ambiguous", () => {
    const r = resolveFileTarget(G, "+server.ts");
    expect("ambiguous" in r).toBe(true);
    if ("ambiguous" in r) {
      expect(r.ambiguous.sort()).toEqual(
        ["src/routes/admin/+server.ts", "src/routes/data/+server.ts"].sort(),
      );
    }
  });

  it("returns none when nothing matches", () => {
    expect("none" in resolveFileTarget(G, "nope.ts")).toBe(true);
  });
});

async function ctxWith(graph: GraphSchema): Promise<ServerContext> {
  const dir = await mkdtemp(join(tmpdir(), "syn-mcp-"));
  const paths = resolvePaths(dir);
  return { paths, graph, symbolIndex: {}, activity: new ActivityStore(paths.activityLog) };
}

describe("per-file usage capture", () => {
  it("graph_read records a 'read' access in access_log.jsonl", async () => {
    const ctx = await ctxWith(graphOf("src/a.ts", "src/b.ts"));
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "graph_read", arguments: { target: "src/a.ts" } },
      },
      ctx,
    );
    expect(res.error).toBeUndefined();

    const rows = (await readFile(ctx.paths.accessLog, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { path: string; source: string });
    expect(rows.some((r) => r.path === "src/a.ts" && r.source === "read")).toBe(true);
  });

  it("graph_read still succeeds for a missing file (no access logged, no throw)", async () => {
    const ctx = await ctxWith(graphOf("src/a.ts"));
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "graph_read", arguments: { target: "ghost.ts" } },
      },
      ctx,
    );
    // Tool-level "not found" is returned as a result (isError), never a transport error.
    expect(res.error).toBeUndefined();
  });
});

function symNode(file: string, name: string, start: number, end: number): SymbolNode {
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

async function blastText(graph: GraphSchema, target: string): Promise<string> {
  const ctx = await ctxWith(graph);
  const res = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "blast_radius", arguments: { target } },
    },
    ctx,
  );
  const result = res.result as { content: Array<{ text: string }> } | undefined;
  return result?.content?.[0]?.text ?? "";
}

describe("blast_radius — calls projected to file level", () => {
  // a.ts::caller → b.ts::target (cross-file); a.ts::localCaller → a.ts::localTarget (intra-file).
  const a = fileNode("src/a.ts");
  const b = fileNode("src/b.ts");
  const callerA = symNode("src/a.ts", "caller", 1, 10);
  const targetB = symNode("src/b.ts", "target", 1, 5);
  const localCaller = symNode("src/a.ts", "localCaller", 12, 20);
  const localTarget = symNode("src/a.ts", "localTarget", 22, 30);
  const graph: GraphSchema = {
    root: ".",
    node_count: 6,
    edge_count: 2,
    file_count: 2,
    symbol_count: 4,
    nodes: [a, b, callerA, targetB, localCaller, localTarget],
    edges: [
      { from: callerA.id, to: targetB.id, kind: "calls" },
      { from: localCaller.id, to: localTarget.id, kind: "calls" },
    ],
    generated_at: "1970-01-01T00:00:00.000Z",
    schema_version: 2,
  };

  it("lists the caller's file as a dependent via calls", async () => {
    const text = await blastText(graph, "src/b.ts");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("via calls");
  });

  it("does not add a self-dependent for an intra-file call", async () => {
    const text = await blastText(graph, "src/a.ts");
    // a.ts has no INCOMING calls; the intra-file edge is skipped, so it's isolated.
    expect(text).toMatch(/no dependents|isolated/);
    expect(text).not.toContain("via calls");
  });
});

describe("graph_read — edit footer (v0.5.0)", () => {
  function graphWithSymbol(): GraphSchema {
    const f: FileNode = {
      id: "file:src/a.ts",
      kind: "file",
      path: "src/a.ts",
      ext: ".ts",
      size: 1,
      keywords: [],
      content: "line1\nfunction foo() {\n  return 1;\n}\nline5\nline6\n",
      summary: "",
      file_hash: "x",
    };
    const s = symNode("src/a.ts", "foo", 2, 4);
    return {
      root: ".",
      node_count: 2,
      edge_count: 0,
      file_count: 1,
      symbol_count: 1,
      nodes: [f, s],
      edges: [],
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    };
  }

  async function readText(graph: GraphSchema, target: string): Promise<string> {
    const ctx = await ctxWith(graph);
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "graph_read", arguments: { target } },
      },
      ctx,
    );
    const result = res.result as { content: Array<{ text: string }> } | undefined;
    return result?.content?.[0]?.text ?? "";
  }

  it("appends a targeted-Read edit recipe for a symbol read", async () => {
    const text = await readText(graphWithSymbol(), "src/a.ts::foo");
    // offset = max(1, start-2) = max(1,0) = 1 ; limit = (4-2+1)+4 = 7
    expect(text).toContain('Read("src/a.ts", offset=1, limit=7)');
    expect(text).toContain("then Edit");
    expect(text).toContain("do NOT re-read the whole file");
  });

  it("does not append the edit footer for a bare-file read", async () => {
    const text = await readText(graphWithSymbol(), "src/a.ts");
    expect(text).not.toContain("To edit this symbol");
    expect(text).toContain("line1"); // whole-file content still returned
  });
});

describe("buildDepsFooter — dependency surface (v0.6.0)", () => {
  const login = symNode("src/auth.ts", "login", 3, 6);
  const findUser = {
    ...symNode("src/users.ts", "findUser", 1, 4),
    signature: "findUser(email: string): Promise<User|null>",
  };
  const createSession = {
    ...symNode("src/session.ts", "createSession", 1, 5),
    signature: "createSession(user: User): Session",
  };
  const handleLogin = symNode("src/routes/auth.ts", "handleLogin", 10, 20);

  function depsGraph(edges: Array<{ from: string; to: string }>): GraphSchema {
    const nodes: SymbolNode[] = [login, findUser, createSession, handleLogin];
    return {
      root: ".",
      node_count: nodes.length,
      edge_count: edges.length,
      file_count: 4,
      symbol_count: nodes.length,
      nodes,
      edges: edges.map((e) => ({ ...e, kind: "calls" as const })),
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    };
  }

  it("lists callees with full signatures + namespaced graph_read targets", () => {
    const footer = buildDepsFooter(
      login,
      depsGraph([
        { from: login.id, to: findUser.id },
        { from: login.id, to: createSession.id },
      ]),
    );
    expect(footer).toContain("Depends on");
    expect(footer).toContain("findUser(email: string): Promise<User|null>");
    expect(footer).toContain('mcp__synthra__graph_read("src/users.ts::findUser")');
    expect(footer).toContain('mcp__synthra__graph_read("src/session.ts::createSession")');
  });

  it("lists callers by name + file only (no caller signature)", () => {
    const footer = buildDepsFooter(login, depsGraph([{ from: handleLogin.id, to: login.id }]));
    expect(footer).toContain("Used by (1):");
    expect(footer).toContain("handleLogin → src/routes/auth.ts");
    expect(footer).not.toContain("handleLogin("); // names only, no signature
  });

  it("returns '' for a leaf symbol with no call edges", () => {
    expect(buildDepsFooter(login, depsGraph([]))).toBe("");
  });

  it("skips recursion self-edges", () => {
    expect(buildDepsFooter(login, depsGraph([{ from: login.id, to: login.id }]))).toBe("");
  });

  it("drops whole callee entries under a tight budget (never splits an entry)", () => {
    const footer = buildDepsFooter(
      login,
      depsGraph([
        { from: login.id, to: findUser.id },
        { from: login.id, to: createSession.id },
      ]),
      120,
    );
    expect(footer).toContain("…+");
    const calleeLines = footer.split("\n").filter((l) => l.startsWith("•"));
    expect(calleeLines.length).toBeLessThan(2);
  });

  it("graph_read places the deps footer before the edit recipe (integration)", async () => {
    const authFile: FileNode = {
      id: "file:src/auth.ts",
      kind: "file",
      path: "src/auth.ts",
      ext: ".ts",
      size: 1,
      keywords: [],
      content: "l1\nl2\nfunction login() {\n  return findUser();\n}\nl6\n",
      summary: "",
      file_hash: "x",
    };
    const g: GraphSchema = {
      root: ".",
      node_count: 3,
      edge_count: 1,
      file_count: 2,
      symbol_count: 2,
      nodes: [authFile, login, findUser],
      edges: [{ from: login.id, to: findUser.id, kind: "calls" }],
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    };
    const ctx = await ctxWith(g);
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "graph_read", arguments: { target: "src/auth.ts::login" } },
      },
      ctx,
    );
    const text = (res.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("Depends on");
    expect(text).toContain('mcp__synthra__graph_read("src/users.ts::findUser")');
    // the edit recipe stays last
    expect(text.indexOf("Depends on")).toBeLessThan(text.indexOf("✎ To edit this symbol"));
  });
});

// ---- v0.11.0: edit-safety bundle ----

describe("buildTestsFooter — test-link awareness (v0.11.0)", () => {
  function testGraph(linked: boolean, symbolFile = "src/a.ts"): GraphSchema {
    const src = fileNode("src/a.ts");
    const testF = fileNode("src/a.test.ts");
    const greet = symNode(symbolFile, "greet", 1, 3);
    const edges = linked ? [{ from: testF.id, to: src.id, kind: "tests" as const }] : [];
    return {
      root: ".",
      node_count: 3,
      edge_count: edges.length,
      file_count: 2,
      symbol_count: 1,
      nodes: [src, testF, greet],
      edges,
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    };
  }
  const symOf = (g: GraphSchema) => g.nodes.find((n): n is SymbolNode => n.kind === "symbol")!;

  it("names the covering test file when a tests edge exists", () => {
    const footer = buildTestsFooter(symOf(testGraph(true)), testGraph(true));
    expect(footer).toContain("Tests (file-level): src/a.test.ts");
    expect(footer).toContain("run after editing");
  });

  it("nudges when an ordinary source symbol has no linked test", () => {
    const g = testGraph(false);
    expect(buildTestsFooter(symOf(g), g)).toBe("Tests: none linked to this file.");
  });

  it("stays silent for a symbol that lives in a test file", () => {
    const g = testGraph(false, "src/a.test.ts");
    expect(buildTestsFooter(symOf(g), g)).toBe("");
  });
});

describe("graph_read — test-link footer (v0.11.0)", () => {
  function g(linked: boolean): GraphSchema {
    const f: FileNode = {
      id: "file:src/a.ts",
      kind: "file",
      path: "src/a.ts",
      ext: ".ts",
      size: 1,
      keywords: [],
      content: "function foo() {\n  return 1;\n}\n",
      summary: "",
      file_hash: "x",
    };
    const tf = fileNode("src/a.test.ts");
    const foo = symNode("src/a.ts", "foo", 1, 3);
    return {
      root: ".",
      node_count: 3,
      edge_count: linked ? 1 : 0,
      file_count: 2,
      symbol_count: 1,
      nodes: [f, tf, foo],
      edges: linked ? [{ from: tf.id, to: f.id, kind: "tests" as const }] : [],
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    };
  }
  async function read(graph: GraphSchema): Promise<string> {
    const ctx = await ctxWith(graph);
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "graph_read", arguments: { target: "src/a.ts::foo" } },
      },
      ctx,
    );
    return (res.result as { content: Array<{ text: string }> }).content[0].text;
  }

  it("shows the covering test file before the edit recipe", async () => {
    const text = await read(g(true));
    expect(text).toContain("Tests (file-level): src/a.test.ts");
    expect(text.indexOf("Tests (file-level)")).toBeLessThan(text.indexOf("✎ To edit this symbol"));
  });

  it("shows the none-linked nudge when no test covers the file", async () => {
    expect(await read(g(false))).toContain("Tests: none linked to this file.");
  });
});

describe("blast_radius — symbol-level impact (v0.11.0)", () => {
  // src/b.ts::helper calls src/a.ts::greet; src/a.test.ts tests src/a.ts.
  const a = fileNode("src/a.ts");
  const b = fileNode("src/b.ts");
  const at = fileNode("src/a.test.ts");
  const greet = symNode("src/a.ts", "greet", 1, 3);
  const helper = symNode("src/b.ts", "helper", 1, 5);
  const graph: GraphSchema = {
    root: ".",
    node_count: 5,
    edge_count: 2,
    file_count: 3,
    symbol_count: 2,
    nodes: [a, b, at, greet, helper],
    edges: [
      { from: helper.id, to: greet.id, kind: "calls" },
      { from: at.id, to: a.id, kind: "tests" },
    ],
    generated_at: "1970-01-01T00:00:00.000Z",
    schema_version: 2,
  };

  it("lists caller symbols (name → file:line) for a file::symbol target", async () => {
    const text = await blastText(graph, "src/a.ts::greet");
    expect(text).toContain("caller symbol(s)");
    expect(text).toContain("`helper` → src/b.ts:1");
  });

  it("surfaces the tests guarding the impact", async () => {
    const text = await blastText(graph, "src/a.ts::greet");
    expect(text).toContain("Tests covering the impact: src/a.test.ts");
  });

  it("reports a symbol with no callers as safe to rename", async () => {
    const text = await blastText(graph, "src/b.ts::helper");
    expect(text).toContain("safe to rename");
  });

  it("errors clearly when the symbol is not found", async () => {
    expect(await blastText(graph, "src/a.ts::ghost")).toContain("not found");
  });
});

// ---- v0.12.0: reuse detection ----

describe("find_symbol + duplicate_symbols (v0.12.0)", () => {
  function symGraph(nodes: SymbolNode[]): GraphSchema {
    return {
      root: ".",
      node_count: nodes.length,
      edge_count: 0,
      file_count: 0,
      symbol_count: nodes.length,
      nodes,
      edges: [],
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    };
  }
  async function callText(
    graph: GraphSchema,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const ctx = await ctxWith(graph);
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name, arguments: args } },
      ctx,
    );
    return (res.result as { content: Array<{ text: string }> }).content[0].text;
  }

  it("find_symbol lists every exact definition with graph_read targets", async () => {
    const g = symGraph([
      symNode("src/utils.ts", "formatDate", 12, 14),
      symNode("src/legacy.ts", "formatDate", 40, 45),
    ]);
    const text = await callText(g, "find_symbol", { name: "formatDate" });
    expect(text).toContain("Exact matches (2)");
    expect(text).toContain('mcp__synthra__graph_read("src/utils.ts::formatDate")');
    expect(text).toContain('mcp__synthra__graph_read("src/legacy.ts::formatDate")');
  });

  it("find_symbol falls back to similar names when there's no exact match", async () => {
    const g = symGraph([symNode("src/utils.ts", "formatDate", 12, 14)]);
    const text = await callText(g, "find_symbol", { name: "formatDat" });
    expect(text).toContain("Similar names");
    expect(text).toContain('mcp__synthra__graph_read("src/utils.ts::formatDate")');
  });

  it("find_symbol green-lights a genuinely new name", async () => {
    const g = symGraph([symNode("src/utils.ts", "formatDate", 12, 14)]);
    const text = await callText(g, "find_symbol", { name: "zzznope" });
    expect(text).toContain("safe to create");
  });

  it("duplicate_symbols flags cross-file names, excludes single-file + methods", async () => {
    const g = symGraph([
      symNode("src/utils.ts", "formatDate", 1, 2),
      symNode("src/legacy.ts", "formatDate", 1, 2), // same name, 2 files → flagged
      symNode("src/a.ts", "helper", 1, 2), // single file → not flagged
      { ...symNode("src/x.ts", "render", 1, 2), symbol_kind: "method" },
      { ...symNode("src/y.ts", "render", 1, 2), symbol_kind: "method" }, // methods → excluded
    ]);
    const text = await callText(g, "duplicate_symbols", {});
    expect(text).toContain("`formatDate` (2)");
    expect(text).not.toContain("helper");
    expect(text).not.toContain("render");
  });
});

describe("call_path (v0.13.0)", () => {
  // A → B → C chain (cross-file calls); D is unrelated.
  const a = symNode("src/a.ts", "A", 1, 5);
  const b = symNode("src/b.ts", "B", 1, 5);
  const c = symNode("src/c.ts", "C", 1, 5);
  const d = symNode("src/d.ts", "D", 1, 5);
  const graph: GraphSchema = {
    root: ".",
    node_count: 8,
    edge_count: 2,
    file_count: 4,
    symbol_count: 4,
    // file nodes are needed for file::symbol resolution (resolveFileTarget)
    nodes: [
      fileNode("src/a.ts"),
      fileNode("src/b.ts"),
      fileNode("src/c.ts"),
      fileNode("src/d.ts"),
      a,
      b,
      c,
      d,
    ],
    edges: [
      { from: a.id, to: b.id, kind: "calls" },
      { from: b.id, to: c.id, kind: "calls" },
    ],
    generated_at: "1970-01-01T00:00:00.000Z",
    schema_version: 2,
  };
  async function pathText(args: Record<string, unknown>): Promise<string> {
    const ctx = await ctxWith(graph);
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "call_path", arguments: args },
      },
      ctx,
    );
    return (res.result as { content: Array<{ text: string }> }).content[0].text;
  }

  it("traces the shortest chain for file::symbol targets", async () => {
    const text = await pathText({ from: "src/a.ts::A", to: "src/c.ts::C" });
    expect(text).toContain("2 hops");
    expect(text).toContain("`A`");
    expect(text).toContain("`B`");
    expect(text).toContain("`C`");
  });

  it("resolves bare unique names", async () => {
    const text = await pathText({ from: "A", to: "C" });
    expect(text).toContain("`A`");
    expect(text).toContain("`C`");
  });

  it("reports no path when the target is unreachable", async () => {
    expect(await pathText({ from: "A", to: "D" })).toContain("no call path found");
  });
});
