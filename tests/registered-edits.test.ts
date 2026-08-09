// v0.27 — the registered-edits set has to be bounded.
//
// It is process-global and the MCP server outlives any one Claude session, so
// a plain Set grew forever AND leaked one session's edits into the next — where
// they rode into that session's `filesTouched` snapshot as if freshly worked on.
// Bounded by age rather than cleared at Stop: an MCP tool call carries no
// session id, and two Claude windows can share one server.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { ServerContext } from "../src/server/context.js";
import { __resetRegisteredEdits, getRegisteredEdits, handleMcpRequest } from "../src/server/mcp.js";
import { SCHEMA_VERSION, type GraphSchema } from "../src/graph/types.js";
import { resolvePaths } from "../src/shared/paths.js";

const HOUR = 60 * 60 * 1000;

function emptyGraph(): GraphSchema {
  return {
    schema_version: SCHEMA_VERSION,
    root: "/tmp/x",
    generated_at: new Date().toISOString(),
    node_count: 0,
    edge_count: 0,
    file_count: 0,
    symbol_count: 0,
    nodes: [],
    edges: [],
  };
}

async function ctx(): Promise<ServerContext> {
  const dir = await mkdtemp(join(tmpdir(), "syn-edits-"));
  const paths = resolvePaths(dir);
  return {
    paths,
    graph: emptyGraph(),
    symbolIndex: {},
    activity: new ActivityStore(paths.activityLog),
  };
}

const register = (c: ServerContext, files: string[]) =>
  handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "graph_register_edit", arguments: { files } },
    },
    c,
  );

describe("registered edits", () => {
  beforeEach(() => __resetRegisteredEdits());

  it("returns what was just registered, newest first", async () => {
    const c = await ctx();
    await register(c, ["src/a.ts"]);
    await register(c, ["src/b.ts"]);
    expect(getRegisteredEdits()).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("drops edits older than the window", async () => {
    // The window matches ctx.activity.recentFilePaths, so both halves of
    // "files touched this session" agree instead of one of them never expiring.
    const c = await ctx();
    await register(c, ["src/stale.ts"]);
    expect(getRegisteredEdits(Date.now() + 25 * HOUR)).toEqual([]);
  });

  it("keeps edits inside the window", async () => {
    const c = await ctx();
    await register(c, ["src/fresh.ts"]);
    expect(getRegisteredEdits(Date.now() + 2 * HOUR)).toEqual(["src/fresh.ts"]);
  });

  it("re-registering a file refreshes it rather than duplicating it", async () => {
    const c = await ctx();
    await register(c, ["src/a.ts"]);
    await register(c, ["src/b.ts", "src/a.ts"]);
    const edits = getRegisteredEdits();
    expect(edits.filter((p) => p === "src/a.ts")).toHaveLength(1);
    expect(edits).toContain("src/b.ts");
  });

  it("caps total entries, discarding the oldest", async () => {
    const c = await ctx();
    // 600 distinct files against a 500 cap.
    for (let i = 0; i < 600; i++) await register(c, [`src/f${i}.ts`]);
    const edits = getRegisteredEdits();
    expect(edits.length).toBeLessThanOrEqual(500);
    // The most recent survived; the very first did not.
    expect(edits).toContain("src/f599.ts");
    expect(edits).not.toContain("src/f0.ts");
  });

  it("reports the tracked count without claiming it's session-scoped", async () => {
    const c = await ctx();
    const res = await register(c, ["src/a.ts"]);
    const text = JSON.stringify(res.result);
    expect(text).toContain("Registered 1 edited file(s)");
    expect(text).not.toContain("this session");
  });
});
