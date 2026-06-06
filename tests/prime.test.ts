// Resume digest in the SessionStart primer.

import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { GraphSchema } from "../src/graph/types.js";
import { writeSession, SESSION_SCHEMA_VERSION, type SessionState } from "../src/memory/session.js";
import type { ServerContext } from "../src/server/context.js";
import { handlePrime } from "../src/server/routes/prime.js";
import { resolvePaths } from "../src/shared/paths.js";

async function fixtureCtx(): Promise<ServerContext> {
  const dir = await mkdtemp(join(tmpdir(), "syn-prime-"));
  const paths = resolvePaths(dir);
  const graph: GraphSchema = {
    root: dir,
    node_count: 0,
    edge_count: 0,
    file_count: 7,
    symbol_count: 42,
    nodes: [],
    edges: [],
    generated_at: "2026-06-06T00:00:00.000Z",
    schema_version: 1,
  };
  return { paths, graph, symbolIndex: {}, activity: new ActivityStore(paths.activityLog) };
}

describe("handlePrime resume digest", () => {
  it("returns the legacy primer when there is no snapshot", async () => {
    const ctx = await fixtureCtx();
    const { primer } = await handlePrime(ctx, 8901);
    expect(primer).toContain("files indexed");
    expect(primer).not.toContain("Since you were last here");
  });

  it("leads with a 'Since you were last here' digest when a snapshot exists", async () => {
    const ctx = await fixtureCtx();
    const snap: SessionState = {
      schema_version: SESSION_SCHEMA_VERSION,
      endedAt: "2026-06-06T12:00:00.000Z",
      branch: "main",
      filesTouched: ["src/auth.ts"],
      recentCommits: [
        { hash: "abc1234", message: "fix auth token expiry", date: "2026-06-05T10:00:00.000Z" },
      ],
      summary: { tasks: [], decisions: [], next: ["add refresh-token rotation"] },
    };
    await writeSession(ctx.paths.sessionState, snap);

    const { primer } = await handlePrime(ctx, 8901);
    expect(primer).toContain("Since you were last here");
    expect(primer).toContain("src/auth.ts");
    expect(primer).toContain("add refresh-token rotation");
    // Legacy primer still appended after the digest.
    expect(primer).toContain("files indexed");

    // The digest portion (before the --- separator) stays within the char cap.
    const digest = primer.split("\n\n---\n\n")[0] ?? "";
    expect(digest.length).toBeLessThanOrEqual(2720);
  });

  it("falls back to legacy when a snapshot has no content", async () => {
    const ctx = await fixtureCtx();
    await writeSession(ctx.paths.sessionState, {
      schema_version: SESSION_SCHEMA_VERSION,
      endedAt: "2026-06-06T12:00:00.000Z",
      branch: "main",
      filesTouched: [],
      recentCommits: [],
      summary: { tasks: [], decisions: [], next: [] },
    });
    const { primer } = await handlePrime(ctx, 8901);
    expect(primer).not.toContain("Since you were last here");
  });
});
