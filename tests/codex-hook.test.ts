// v0.42: Synthra's hooks in Codex (`syn hook <event>`), written by `syn codex`
// into Codex's global hooks file. These check each hook against a live server,
// the token count read from Codex's session file, that Codex never counts as
// Claude (heartbeat) or as spend, and that `syn codex` edits only its own
// entries in the hooks file.

import { describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_HOOKS,
  codexHooksInstalled,
  withOurHooks,
  withoutOurHooks,
} from "../src/cli/codex-command.js";
import { readCodexTurn, runCodexHook } from "../src/cli/codex-hook.js";
import type { DoctorCheck } from "../src/cli/doctor-command.js";
import { runDoctorChecks } from "../src/cli/doctor-command.js";
import type { ProjectFiles } from "../src/dashboard/delta.js";
import { computeCost } from "../src/dashboard/overview.js";
import { startServer } from "../src/server/http.js";
import { estimateCostUsd } from "../src/shared/pricing.js";
import { resolvePaths } from "../src/shared/paths.js";

const tokenCount = (input: number, cached: number, output: number, fiveHour = 10, week = 30) =>
  JSON.stringify({
    timestamp: "2026-10-10T09:04:29.223Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
      },
      rate_limits: {
        primary: { used_percent: fiveHour, window_minutes: 300 },
        secondary: { used_percent: week, window_minutes: 10080 },
      },
    },
  });
const toolCall = JSON.stringify({
  type: "response_item",
  payload: { type: "function_call", name: "shell" },
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "syn-codex-hook-"));
  await mkdir(resolvePaths(root).graphDir, { recursive: true });
  await writeFile(join(root, "a.ts"), "export function alpha() { return 1; }\n");
  return root;
}

async function logLines(root: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(resolvePaths(root).tokenLog, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("reading Codex's session file", () => {
  it("takes the newest totals and limits, and counts tool calls", () => {
    const text = [
      tokenCount(100, 40, 10, 5, 20),
      "not json",
      toolCall,
      toolCall,
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
      tokenCount(300, 200, 50, 7, 21),
      "",
    ].join("\n");
    const turn = readCodexTurn(text);
    expect(turn.totals).toEqual({ input: 300, cached: 200, cacheWrite: 0, output: 50 });
    expect(turn.toolCalls).toBe(2);
    expect(turn.limits).toEqual({ fiveHour: 7, week: 21 });
  });

  it("finds nothing in a file it doesn't understand", () => {
    expect(readCodexTurn('{"type":"other"}\n').totals).toBeNull();
  });
});

describe("syn hook against a live server", () => {
  it("does nothing outside a mapped project, or with no server, or with bad input", async () => {
    const bare = await mkdtemp(join(tmpdir(), "syn-codex-hook-none-"));
    expect(await runCodexHook("session-start", JSON.stringify({ cwd: bare }))).toBeNull();
    const root = await project();
    expect(await runCodexHook("session-start", JSON.stringify({ cwd: root }))).toBeNull();
    expect(await runCodexHook("session-start", "{oops")).toBeNull();
  });

  it("session-start gives Codex the primer as added context", async () => {
    const root = await project();
    const handle = await startServer(resolvePaths(root), { version: "t" });
    try {
      const out = await runCodexHook(
        "session-start",
        JSON.stringify({ cwd: join(root), source: "startup" }),
      );
      const parsed = JSON.parse(out as string);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(String(parsed.hookSpecificOutput.additionalContext).length).toBeGreaterThan(20);
      // Codex is not Claude: the doctor's Claude hook heartbeat stays untouched.
      await expect(stat(resolvePaths(root).heartbeat)).rejects.toThrow();
    } finally {
      await handle.stop();
    }
  }, 30_000);

  it("pre-tool-use records a shell search and never blocks it", async () => {
    const root = await project();
    const handle = await startServer(resolvePaths(root), { version: "t" });
    try {
      const out = await runCodexHook(
        "pre-tool-use",
        JSON.stringify({
          cwd: root,
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: ["rg", "-n", "alpha"] },
        }),
      );
      expect(out).toBeNull();
      const bash = await readFile(resolvePaths(root).bashLog, "utf8");
      expect(bash).toContain("alpha");
    } finally {
      await handle.stop();
    }
  }, 30_000);

  it("stop logs each turn's tokens once, as Codex, and never as spend", async () => {
    const root = await project();
    const transcript = join(root, "rollout.jsonl");
    await writeFile(transcript, `${tokenCount(1000, 600, 100)}\n${toolCall}\n`);
    const handle = await startServer(resolvePaths(root), { version: "t" });
    const stopIn = JSON.stringify({
      cwd: root,
      session_id: "sess-1",
      transcript_path: transcript,
      model: "gpt-6.1-sol",
      stop_hook_active: false,
    });
    try {
      await runCodexHook("stop", stopIn);
      let lines = await logLines(root);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        agent: "codex",
        model: "gpt-6.1-sol",
        input_tokens: 400,
        cache_read_input_tokens: 600,
        output_tokens: 100,
        codex_limits: { fiveHour: 10, week: 30 },
      });

      // The next turn: only what was added since.
      await appendFile(transcript, `${tokenCount(1500, 900, 160, 12, 31)}\n`);
      await runCodexHook("stop", stopIn);
      lines = await logLines(root);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({
        input_tokens: 200,
        cache_read_input_tokens: 300,
        output_tokens: 60,
      });

      // Nothing new: nothing logged.
      await runCodexHook("stop", stopIn);
      expect(await logLines(root)).toHaveLength(2);
      await expect(stat(resolvePaths(root).heartbeat)).rejects.toThrow();
    } finally {
      await handle.stop();
    }
  }, 30_000);
});

describe("Codex on the dashboard", () => {
  it("counts Codex turns apart, at no cost", () => {
    expect(estimateCostUsd({ input_tokens: 1e6, output_tokens: 1e6, model: "gpt-6.1-sol" })).toBe(
      0,
    );
    expect(
      estimateCostUsd({ input_tokens: 1e6, output_tokens: 1e6, model: "", agent: "codex" }),
    ).toBe(0);
    const now = Date.parse("2026-10-10T12:00:00Z");
    const files = {
      path: "/p",
      name: "p",
      last_seen: null,
      tokens: [
        {
          ts: "2026-10-10T10:00:00Z",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          model: "claude-opus-5-5",
          project: "/p",
        },
        {
          ts: "2026-10-10T11:00:00Z",
          input_tokens: 400,
          output_tokens: 100,
          cache_read_input_tokens: 600,
          model: "gpt-6.1-sol",
          project: "/p",
          agent: "codex",
          codex_limits: { fiveHour: 12, week: 31 },
        },
      ],
      gates: [],
      tools: [],
      bash: [],
      routes: [],
      delegations: [],
    } as ProjectFiles;
    const c = computeCost([files], now - 86_400_000, now);
    expect(c.replies).toBe(1);
    expect(c.spend).toBe(24);
    expect(c.codex).toMatchObject({ replies: 1, tokens: 1100, fiveHour: 12, week: 31 });
  });
});

describe("syn codex and Codex's hooks file", () => {
  const theirs = {
    SessionStart: [
      { matcher: ".*", hooks: [{ type: "command" as const, command: "ecc", timeout: 5 }] },
    ],
  };

  it("adds Synthra's hooks once, and keeps everyone else's", () => {
    const once = withOurHooks(theirs);
    expect(withOurHooks(once)).toEqual(once);
    expect(once.SessionStart?.[0]).toEqual(theirs.SessionStart[0]);
    expect(Object.keys(once).sort()).toEqual(["PreToolUse", "SessionStart", "Stop"]);
  });

  it("removes only Synthra's hooks", () => {
    expect(withoutOurHooks(withOurHooks(theirs))).toEqual(theirs);
    expect(withoutOurHooks(withOurHooks({}))).toEqual({});
  });

  it("reports which hooks are installed, and the doctor says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-codex-hooks-"));
    const hooksFile = join(dir, "hooks.json");
    const config = join(dir, "config.toml");
    await writeFile(config, '[mcp_servers.synthra]\ncommand = "syn"\nargs = ["mcp"]\n');
    const line = async () =>
      (
        await runDoctorChecks(dir, {
          environment: false,
          codexConfig: config,
          codexHooks: hooksFile,
        })
      ).find((c: DoctorCheck) => c.label === "Codex");

    expect(await codexHooksInstalled(hooksFile)).toEqual([]);
    expect((await line())?.detail).toContain("no hooks yet");

    await writeFile(hooksFile, JSON.stringify({ hooks: withOurHooks(theirs) }));
    expect(await codexHooksInstalled(hooksFile)).toEqual(Object.keys(CODEX_HOOKS));
    expect((await line())?.detail).toContain("hooks installed");
  });
});
