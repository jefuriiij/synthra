// v0.50 (Radar R-054, R-055). Claude Code writes one reply on several
// transcript lines, one per content block, each with the same message id and
// the same usage. The Stop hooks and the subagent reader added up every line,
// so cost was counted two to three times (measured: $1,170.82 for $476.06).
// The hooks' own test is in stop-hook.test.ts; here: the subagent reader, the
// Fable 5.2 price, and `syn recount`, which fixes what is already logged.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { applyRecount, planRecount, transcriptDirs } from "../src/cli/recount-command.js";
import { sumSubagentUsage } from "../src/server/routes/subagent-usage.js";
import { resolvePaths } from "../src/shared/paths.js";
import { estimateCostUsd, pricingFor } from "../src/shared/pricing.js";

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 1000,
});

/** One reply the way Claude Code writes it: a line per content block. */
function reply(id: string, ts: string, blocks: object[], u = usage(10, 20), extra = {}) {
  return blocks.map((b) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      ...extra,
      message: { id, model: "claude-opus-5-5", usage: u, content: [b] },
    }),
  );
}
const prompt = (ts: string, cwd: string) =>
  JSON.stringify({ type: "user", timestamp: ts, cwd, message: { content: "do it" } });
const text = { type: "text", text: "ok" };
const read = { type: "tool_use", name: "Read", input: { file_path: "a.ts" } };

async function put(path: string, lines: string[], newline = true): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n") + (newline ? "\n" : ""), "utf8");
}

/** A home folder and a project, with the project's transcript folder. */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "syn-recount-home-"));
  const root = resolve(await mkdtemp(join(tmpdir(), "syn-recount-proj-")));
  const dir = join(home, ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
  const paths = resolvePaths(root);
  await mkdir(paths.graphDir, { recursive: true });
  return { home, root, dir, paths };
}

describe("the Fable 5.2 price", () => {
  it("is $8 in, $40 out, $0.20 cache read", () => {
    expect(pricingFor("claude-fable-5-2")).toEqual({
      input: 8,
      output: 40,
      cacheRead: 0.2,
      cacheCreate: 10,
    });
    // 5.1 keeps its own price, and a later 5.x falls back to 5.2, not 5.1.
    expect(pricingFor("claude-fable-5-1").input).toBe(10);
    expect(pricingFor("claude-fable-5-3").input).toBe(8);
  });
});

describe("a subagent's replies are counted once", () => {
  it("skips the lines that repeat a reply's usage", () => {
    const lines = [
      ...reply("msg_a", "2026-11-01T10:00:00.000Z", [text, read, read]),
      ...reply("msg_b", "2026-11-01T10:01:00.000Z", [text]),
    ];
    const [u] = sumSubagentUsage(lines.join("\n"), "x1");
    expect(u?.input_tokens).toBe(20);
    expect(u?.output_tokens).toBe(40);
    expect(u?.cache_read_input_tokens).toBe(2000);
  });

  it("skips a reply the stretch before already counted", () => {
    const seen = new Set(["msg_a"]);
    const lines = [
      ...reply("msg_a", "2026-11-01T10:00:00.000Z", [read]),
      ...reply("msg_b", "2026-11-01T10:01:00.000Z", [text]),
    ];
    const [u] = sumSubagentUsage(lines.join("\n"), "x1", seen);
    expect(u?.input_tokens).toBe(10);
    expect([...seen].pop()).toBe("msg_b");
  });
});

describe("syn recount", () => {
  it("finds the project's transcript folder by Claude Code's naming", async () => {
    const { home, root, dir } = await setup();
    await mkdir(dir, { recursive: true });
    expect(await transcriptDirs(root, home)).toEqual([dir]);
    expect(await transcriptDirs(join(root, "other"), home)).toEqual([]);
  });

  it("counts each reply once, across lines, forks and subagents", async () => {
    const { home, root, dir, paths } = await setup();
    const a = reply("msg_a", "2026-11-01T10:00:05.000Z", [text, read, read]);
    const b = reply("msg_b", "2026-11-01T10:05:00.000Z", [text]);
    await put(join(dir, "s1.jsonl"), [
      prompt("2026-11-01T10:00:00.000Z", root),
      ...a,
      prompt("2026-11-01T10:04:00.000Z", root),
      ...b,
    ]);
    // A fork: it starts with a copy of the first session's lines.
    const c = reply("msg_c", "2026-11-02T09:00:00.000Z", [text]);
    await put(join(dir, "s2.jsonl"), [
      prompt("2026-11-01T10:00:00.000Z", root),
      ...a,
      prompt("2026-11-02T08:59:00.000Z", root),
      ...c,
    ]);
    // A subagent of the first session, its reply on two lines.
    await put(
      join(dir, "s1", "subagents", "agent-k9.jsonl"),
      reply("msg_s", "2026-11-01T10:02:00.000Z", [text, read], usage(3, 4)),
    );
    // Another project whose path gives the same folder name: not ours.
    await put(join(dir, "s3.jsonl"), [
      prompt("2026-11-01T11:00:00.000Z", join(root, "..", "elsewhere")),
      ...reply("msg_z", "2026-11-01T11:00:05.000Z", [text], usage(999, 999)),
    ]);

    // The log as the old hooks wrote it: the first turn three times too high.
    const log = [
      {
        input_tokens: 7,
        output_tokens: 7,
        model: "claude-opus-5-5",
        written_at: "2026-09-01T00:00:00.000Z",
      },
      {
        input_tokens: 30,
        output_tokens: 60,
        cache_read_input_tokens: 3000,
        model: "claude-opus-5-5",
        written_at: "2026-11-01T10:00:06.000Z",
      },
      {
        input_tokens: 5,
        output_tokens: 5,
        model: "gpt-5",
        agent: "codex",
        written_at: "2026-11-01T12:00:00.000Z",
      },
    ];
    await writeFile(paths.tokenLog, log.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");

    const plan = await planRecount(paths, { home });
    expect(plan.transcripts).toBe(2);
    expect(plan.replies).toBe(4); // a, b, c and the subagent's
    expect(plan.since).toBe("2026-11-01T10:00:05.000Z");
    const turns = plan.entries.filter((e) => !e.subagent);
    expect(turns.map((e) => [e.input_tokens, e.output_tokens, e.read_calls])).toEqual([
      [10, 20, 2],
      [10, 20, 0],
      [10, 20, 0],
    ]);
    const [sub] = plan.entries.filter((e) => e.subagent);
    expect(sub).toMatchObject({ subagent: "k9", input_tokens: 3, output_tokens: 4 });
    expect(plan.costAfter).toBeLessThan(plan.costBefore * 2);
    expect(plan.costBefore).toBeCloseTo(estimateCostUsd(log[1] as never), 6);

    // The old entry and Codex's stay; the inflated one is replaced.
    const stamps = plan.nextLog.map((e) => e.written_at);
    expect(stamps).toContain("2026-09-01T00:00:00.000Z");
    expect(stamps).toContain("2026-11-01T12:00:00.000Z");
    expect(stamps).not.toContain("2026-11-01T10:00:06.000Z");
    expect(plan.nextLog).toHaveLength(2 + 4);

    const backup = await applyRecount(paths, plan, new Date("2026-11-19T08:00:00.000Z"));
    expect(backup).toMatch(/token_log\.jsonl\.before-recount-20261119T080000$/);
    expect(await readFile(backup as string, "utf8")).toContain("2026-11-01T10:00:06.000Z");
    const written = (await readFile(paths.tokenLog, "utf8")).trim().split("\n");
    expect(written).toHaveLength(6);
    // The Stop hook goes on from the end of each transcript it read.
    expect(await readFile(join(dir, "s1.jsonl.stopoffset"), "utf8")).toBe("6");
    expect(await readFile(join(dir, "s2.jsonl.stopoffset"), "utf8")).toBe("6");
    expect((await readdir(dir)).includes("s3.jsonl.stopoffset")).toBe(false);
    const marks = JSON.parse(await readFile(join(paths.graphDir, "subagent_offsets.json"), "utf8"));
    const mark = Object.values(marks)[0] as { offset: number; last: string };
    expect(mark.last).toBe("msg_s");
    expect(mark.offset).toBeGreaterThan(0);

    // Run again: nothing left to change.
    const again = await planRecount(paths, { home });
    expect(again.costBefore).toBeCloseTo(again.costAfter, 6);
  });

  it("leaves a line Claude Code is still writing for the Stop hook", async () => {
    const { home, root, dir, paths } = await setup();
    await put(
      join(dir, "s1.jsonl"),
      [
        prompt("2026-11-01T10:00:00.000Z", root),
        ...reply("msg_a", "2026-11-01T10:00:05.000Z", [text]),
        '{"type":"assistant","message":{"id":"msg_b","usa',
      ],
      false,
    );
    const plan = await planRecount(paths, { home });
    expect(plan.replies).toBe(1);
    expect(plan.offsets).toEqual([{ file: join(dir, "s1.jsonl"), lines: 2 }]);
  });

  it("changes nothing when there is no transcript", async () => {
    const { home, paths } = await setup();
    const plan = await planRecount(paths, { home });
    expect(plan.transcripts).toBe(0);
    expect(plan.since).toBeNull();
  });
});
