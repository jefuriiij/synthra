// graph_read target resolution (#11) + per-file usage capture.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { FileNode, GraphSchema, SymbolNode } from "../src/graph/types.js";
import type { ServerContext } from "../src/server/context.js";
import { handleMcpRequest, resolveFileTarget } from "../src/server/mcp.js";
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
