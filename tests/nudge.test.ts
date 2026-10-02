// POST /nudge — Hermes' memory nudge, in the same chat: every N Claude replies
// without a change to MEMORY.md or USER.md, the Stop hook holds Claude for one
// step to save what it learned.

import { afterEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { ServerContext } from "../src/server/context.js";
import { handleNudge, noteSkillSaved } from "../src/server/routes/nudge.js";
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
    const r = await replies(c, 3);
    expect(r.map((x) => Boolean(x.reason))).toEqual([false, false, true]);
    expect(r[2]?.reason).toContain("mcp__synthra__memory");
    // The step the nudge asked for, as Claude Code reports it.
    await handleNudge({ stop_hook_active: true }, c);
    expect((await replies(c, 3)).map((x) => Boolean(x.reason))).toEqual([false, false, true]);
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

  // The belt to stop_hook_active's braces: without the marker, the stop right
  // after a nudge is still the nudged step, so it can't be nudged in turn.
  it("never asks twice in a row, even when the marker is missing", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "1";
    const c = await ctx();
    expect((await replies(c, 5)).map((x) => Boolean(x.reason))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  // The dashboard compares reminders with the saves that followed.
  it("logs each reminder that fires, and nothing else", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "2";
    const c = await ctx();
    await replies(c, 2);
    await handleNudge({ stop_hook_active: true }, c);
    await replies(c, 1);
    const lines = (await readFile(c.paths.nudgeLog, "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["memory"]);
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

describe("POST /nudge — the skill nudge", () => {
  afterEach(() => {
    delete process.env.SYN_SKILL_NUDGE_EVERY;
  });

  it("asks once the replies' tool calls add up, then starts over", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "0";
    process.env.SYN_SKILL_NUDGE_EVERY = "10";
    const c = await ctx();
    expect(await handleNudge({ tool_calls: 4 }, c)).toEqual({});
    expect(await handleNudge({ tool_calls: 5 }, c)).toEqual({});
    const r = await handleNudge({ tool_calls: 3 }, c);
    expect(r.reason).toContain("skill check - after 12 tool calls");
    expect(r.reason).toContain("mcp__synthra__skill_manage");
    expect(await handleNudge({ tool_calls: 9 }, c)).toEqual({});
  });

  // The real order: the save happens mid-reply, and the Stop hook then
  // reports that whole reply's calls — the ones before the save included.
  it("doesn't ask right after a reply that saved a skill", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "0";
    process.env.SYN_SKILL_NUDGE_EVERY = "10";
    const c = await ctx();
    await handleNudge({ tool_calls: 8 }, c);
    noteSkillSaved(c); // during the next reply
    expect(await handleNudge({ tool_calls: 17 }, c)).toEqual({});
    // Counting starts over after it: 9 more is not enough, 10 is.
    expect(await handleNudge({ tool_calls: 9 }, c)).toEqual({});
    expect((await handleNudge({ tool_calls: 1 }, c)).reason).toBeTruthy();
  });

  it("ignores the nudged step's calls, but a save in it still resets", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "0";
    process.env.SYN_SKILL_NUDGE_EVERY = "10";
    const c = await ctx();
    await handleNudge({ tool_calls: 8 }, c);
    expect(await handleNudge({ tool_calls: 50, stop_hook_active: true }, c)).toEqual({});
    expect((await handleNudge({ tool_calls: 2 }, c)).reason).toBeTruthy();

    await handleNudge({ tool_calls: 8 }, c);
    noteSkillSaved(c);
    await handleNudge({ tool_calls: 3, stop_hook_active: true }, c);
    expect(await handleNudge({ tool_calls: 9 }, c)).toEqual({});
  });

  // A nudged step that does real work (views skills, saves one) can make many
  // calls. Without the marker, those must not set off the next nudge.
  it("doesn't let a nudged step's calls nudge again, even without the marker", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "0";
    process.env.SYN_SKILL_NUDGE_EVERY = "10";
    const c = await ctx();
    expect((await handleNudge({ tool_calls: 12 }, c)).reason).toBeTruthy();
    expect(await handleNudge({ tool_calls: 50 }, c)).toEqual({});
    expect(await handleNudge({ tool_calls: 9 }, c)).toEqual({});
    expect((await handleNudge({ tool_calls: 1 }, c)).reason).toBeTruthy();
  });

  it("asks one combined question when both are due", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "1";
    process.env.SYN_SKILL_NUDGE_EVERY = "5";
    const r = await handleNudge({ tool_calls: 6 }, await ctx());
    expect(r.reason).toMatch(/^\[Synthra review\]/);
    expect(r.reason).toContain("1) Memory");
    expect(r.reason).toContain("2) Skill");
    expect(r.reason).toMatch(/^[\x20-\x7e]+$/);
  });

  it("is off with SYN_SKILL_NUDGE_EVERY=0, and shrugs off a wild count", async () => {
    process.env.SYN_MEMORY_NUDGE_EVERY = "0";
    process.env.SYN_SKILL_NUDGE_EVERY = "0";
    expect(await handleNudge({ tool_calls: 1000 }, await ctx())).toEqual({});
    process.env.SYN_SKILL_NUDGE_EVERY = "200";
    const c = await ctx();
    expect(await handleNudge({ tool_calls: 1e9 }, c)).toMatchObject({
      reason: expect.stringContaining("after 500"),
    });
    expect(await handleNudge({ tool_calls: Number.NaN }, c)).toEqual({});
  });
});
