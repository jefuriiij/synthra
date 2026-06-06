// Stop-hook route: refreshes CONTEXT.md AND captures a session snapshot.

import { describe, it, expect } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { GraphSchema } from "../src/graph/types.js";
import { rememberEntry } from "../src/memory/index.js";
import { readSession } from "../src/memory/session.js";
import type { ServerContext } from "../src/server/context.js";
import { handleContextUpdate } from "../src/server/routes/context-update.js";
import { resolvePaths } from "../src/shared/paths.js";

async function fixtureCtx(): Promise<ServerContext> {
  const dir = await mkdtemp(join(tmpdir(), "syn-ctxupd-"));
  const paths = resolvePaths(dir);
  const graph: GraphSchema = {
    root: dir,
    node_count: 0,
    edge_count: 0,
    file_count: 0,
    symbol_count: 0,
    nodes: [],
    edges: [],
    generated_at: "2026-06-06T00:00:00.000Z",
    schema_version: 1,
  };
  return { paths, graph, symbolIndex: {}, activity: new ActivityStore(paths.activityLog) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("handleContextUpdate", () => {
  it("refreshes CONTEXT.md AND writes a session snapshot capturing open next-steps", async () => {
    const ctx = await fixtureCtx();
    await rememberEntry(ctx.paths, { text: "add refresh-token rotation", kind: "next" });

    const res = await handleContextUpdate({}, ctx);
    expect(res.updated).toBe(true);

    // CONTEXT.md refresh still happens (no regression).
    expect(await exists(res.path)).toBe(true);

    // Snapshot captured the open next-step for the next session's digest.
    const snap = await readSession(ctx.paths.sessionState);
    expect(snap).not.toBeNull();
    expect(snap?.summary.next).toContain("add refresh-token rotation");
    expect(snap?.branch).toBe("main"); // no .git in the temp dir → fallback
  });
});
