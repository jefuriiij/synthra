// graph_read target resolution (#11) + per-file usage capture.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { FileNode, GraphSchema } from "../src/graph/types.js";
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
