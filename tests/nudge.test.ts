// POST /nudge — Hermes' memory nudge, in the same chat: every N Claude replies
// without a change to MEMORY.md or USER.md, the Stop hook holds Claude for one
// step to save what it learned.

import { afterEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { ServerContext } from "../src/server/context.js";
import { handleNudge } from "../src/server/routes/nudge.js";
import { resolvePaths } from "../src/shared/paths.js";

async function ctx(): Promise<ServerContext> {
  const dir = await mkdtemp(join(tmpdir(), "syn-nudge-"));
  const paths = resolvePaths(dir, join(dir, "home", ".synthra", "USER.md"));
  return {
    paths,
    graph: {
      root: dir,
      node_count: 0,
      edge_count: 0,
      file_count: 0,
      symbol_count: 0,
      nodes: [],
      edges: [],
      generated_at: "2026-10-02T00:00:00.000Z",
      schema_version: 1,
    },
    symbolIndex: {},
    activity: new ActivityStore(paths.activityLog),
  };
}

const replies = async (c: ServerContext, n: number) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await handleNudge({}, c));
  return out;
};

afterEach(() => {
  delete process.env.SYN_MEMORY_NUDGE_EVERY;
});

describe("POST /nudge", () => {
  it("asks once every N replies, then starts counting again", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "3";
    const c = await ctx();
    const r = await replies(c, 6);
    expect(r.map((x) => Boolean(x.reason))).toEqual([false, false, true, false, false, true]);
    expect(r[2]?.reason).toContain("mcp__synthra__memory");
  });

  // Any change resets it — the tool, another AI's hand edit, the user's.
  it("starts over when MEMORY.md or USER.md changes", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "3";
    const c = await ctx();
    await replies(c, 2);
    await mkdir(c.paths.contextDir, { recursive: true });
    await writeFile(c.paths.memoryMd, "- Use pnpm\n", "utf8");
    // The reply that saved counts as zero; three more, then the nudge.
    const r = await replies(c, 4);
    expect(r.map((x) => Boolean(x.reason))).toEqual([false, false, false, true]);

    await replies(c, 1);
    await mkdir(join(c.paths.userMemory, ".."), { recursive: true });
    await writeFile(c.paths.userMemory, "- Prefers short answers\n", "utf8");
    expect((await replies(c, 4)).map((x) => Boolean(x.reason))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  // The step Claude takes because of a nudge must not count, or be nudged.
  it("ignores a reply made because of a Stop hook", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "2";
    const c = await ctx();
    await handleNudge({}, c);
    expect(await handleNudge({ stop_hook_active: true }, c)).toEqual({});
    expect((await handleNudge({}, c)).reason).toBeTruthy();
  });

  it("is off with SYN_MEMORY_NUDGE_EVERY=0", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "0";
    const c = await ctx();
    expect((await replies(c, 20)).every((x) => !x.reason)).toBe(true);
  });

  it("speaks plain ASCII (the Windows hook prints it through a console)", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "1";
    const r = await handleNudge({}, await ctx());
    expect(r.reason).toMatch(/^[\x20-\x7e]+$/);
  });
});
