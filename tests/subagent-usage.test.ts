// v0.46 (Radar R-038): Claude Code keeps each subagent's turns in
// <session>/subagents/agent-*.jsonl, which the Stop hook never read, so the
// dashboard missed their cost (5.4% over 30 days on a real machine). /log now
// counts them, once each, as cost but never as replies.

import { describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { ProjectFiles } from "../src/dashboard/delta.js";
import { computeCost } from "../src/dashboard/overview.js";
import type { ServerContext } from "../src/server/context.js";
import { handleLog } from "../src/server/routes/log.js";
import { newSubagentUsage, sumSubagentUsage } from "../src/server/routes/subagent-usage.js";
import { resolvePaths } from "../src/shared/paths.js";

const turn = (model: string, input: number, output: number, oneHour = 0) =>
  JSON.stringify({
    message: {
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: oneHour,
        cache_read_input_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: oneHour },
      },
    },
  });

async function setup(): Promise<{ ctx: ServerContext; transcript: string; subs: string }> {
  const root = await mkdtemp(join(tmpdir(), "syn-subagents-"));
  const paths = resolvePaths(root);
  await mkdir(paths.graphDir, { recursive: true });
  const sessions = join(root, "claude-projects");
  const transcript = join(sessions, "sess-1.jsonl");
  const subs = join(sessions, "sess-1", "subagents");
  await mkdir(subs, { recursive: true });
  await writeFile(transcript, `${turn("claude-opus-5-5", 5, 7)}\n`);
  const ctx: ServerContext = {
    paths,
    graph: {
      root: ".",
      node_count: 0,
      edge_count: 0,
      file_count: 0,
      symbol_count: 0,
      nodes: [],
      edges: [],
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    },
    symbolIndex: {},
    activity: new ActivityStore(paths.activityLog),
  };
  return { ctx, transcript, subs };
}

describe("reading a subagent's transcript", () => {
  it("sums usage per model and skips lines that don't parse", () => {
    const text = [
      turn("claude-sonnet-5-5", 10, 20, 100),
      "{not json",
      turn("claude-sonnet-5-5", 1, 2),
      turn("claude-haiku-5-5", 3, 4),
      JSON.stringify({ type: "user", message: { content: "hi" } }),
    ].join("\n");
    expect(sumSubagentUsage(text, "a1")).toEqual([
      {
        subagent: "a1",
        model: "claude-sonnet-5-5",
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 20,
        cache_creation_1h_input_tokens: 100,
      },
      {
        subagent: "a1",
        model: "claude-haiku-5-5",
        input_tokens: 3,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
        cache_creation_1h_input_tokens: 0,
      },
    ]);
  });

  it("reads each file once, then only what was added", async () => {
    const { ctx, transcript, subs } = await setup();
    await writeFile(join(subs, "agent-a1.jsonl"), `${turn("claude-sonnet-5-5", 10, 20)}\n`);
    await writeFile(join(subs, "agent-a1.meta.json"), "{}");
    await writeFile(join(subs, "notes.jsonl"), `${turn("claude-sonnet-5-5", 99, 99)}\n`);

    const first = await newSubagentUsage(ctx, transcript);
    expect(first.map((u) => [u.subagent, u.input_tokens])).toEqual([["a1", 10]]);
    expect(await newSubagentUsage(ctx, transcript)).toEqual([]);

    await appendFile(join(subs, "agent-a1.jsonl"), `${turn("claude-sonnet-5-5", 3, 4)}\n`);
    await writeFile(join(subs, "agent-b2.jsonl"), `${turn("claude-haiku-5-5", 1, 1)}\n`);
    const next = await newSubagentUsage(ctx, transcript);
    expect(next.map((u) => [u.subagent, u.input_tokens])).toEqual([
      ["a1", 3],
      ["b2", 1],
    ]);
  });

  it("ignores a missing or odd transcript path", async () => {
    const { ctx } = await setup();
    expect(await newSubagentUsage(ctx, undefined)).toEqual([]);
    expect(await newSubagentUsage(ctx, "relative/sess.jsonl")).toEqual([]);
    expect(await newSubagentUsage(ctx, join(tmpdir(), "no-such-session.jsonl"))).toEqual([]);
  });
});

describe("/log with subagents", () => {
  it("logs the main turn and each subagent, without storing the path", async () => {
    const { ctx, transcript, subs } = await setup();
    await writeFile(join(subs, "agent-a1.jsonl"), `${turn("claude-sonnet-5-5", 10, 20, 50)}\n`);
    await handleLog(
      {
        input_tokens: 5,
        output_tokens: 7,
        model: "claude-opus-5-5",
        project: ctx.paths.projectRoot,
        transcript_path: transcript,
      },
      ctx,
    );
    const lines = (await readFile(ctx.paths.tokenLog, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].transcript_path).toBeUndefined();
    expect(lines[1]).toMatchObject({
      subagent: "a1",
      model: "claude-sonnet-5-5",
      input_tokens: 10,
      cache_creation_1h_input_tokens: 50,
      description: "synthra-subagent",
    });
  });

  it("counts a subagent's work as cost, never as a reply", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const tokens = [
      {
        ts: "2026-10-26T10:00:00Z",
        input_tokens: 1e6,
        output_tokens: 0,
        model: "claude-opus-5-5",
        project: "/p",
      },
      {
        ts: "2026-10-26T10:01:00Z",
        input_tokens: 1e6,
        output_tokens: 0,
        model: "claude-opus-5-5",
        project: "/p",
        subagent: "a1",
      },
    ];
    const files = {
      path: "/p",
      name: "p",
      last_seen: null,
      tokens,
      gates: [],
      tools: [],
      bash: [],
      routes: [],
      delegations: [],
    } as ProjectFiles;
    const c = computeCost([files], now - 86_400_000, now);
    expect(c.spend).toBe(8);
    expect(c.replies).toBe(1);
    expect(c.priciest).toHaveLength(1);
  });
});
