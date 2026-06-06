// graph_read target resolution (#11).

import { describe, it, expect } from "vitest";

import { resolveFileTarget } from "../src/server/mcp.js";
import type { FileNode, GraphSchema } from "../src/graph/types.js";

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
