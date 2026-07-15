// POST /log — token-usage append + the v0.20 delegation events feeding the
// Dispatcher follow-rate.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleLog, type LogEntry } from "../src/server/routes/log.js";
import type { ServerContext } from "../src/server/context.js";
import { resolvePaths } from "../src/shared/paths.js";

async function ctx(): Promise<ServerContext> {
  const dir = await mkdtemp(join(tmpdir(), "syn-log-"));
  return { paths: resolvePaths(dir) } as unknown as ServerContext;
}

const base: LogEntry = {
  input_tokens: 10,
  output_tokens: 20,
  model: "claude-sonnet-5",
  project: "/proj",
};

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("handleLog", () => {
  it("appends token usage and each delegation event to their own logs", async () => {
    const c = await ctx();
    await handleLog(
      {
        ...base,
        delegations: [
          {
            ts: "2026-07-15T10:00:00.000Z",
            agent: "svelte-file-editor",
            model: "sonnet",
            session_id: "abc",
          },
          { ts: "2026-07-15T10:05:00.000Z", agent: null, model: null, session_id: "abc" },
        ],
      },
      c,
    );

    const tokens = await lines(c.paths.tokenLog);
    expect(tokens).toHaveLength(1);
    expect(JSON.parse(tokens[0] as string).delegations).toBeUndefined(); // not duplicated into token_log

    const dele = await lines(c.paths.delegationLog);
    expect(dele).toHaveLength(2);
    const first = JSON.parse(dele[0] as string);
    expect(first.agent).toBe("svelte-file-editor");
    expect(first.session_id).toBe("abc");
    expect(first.written_at).toBeTruthy();
  });

  it("normalizes a single delegation object (PowerShell 5.1 array collapse)", async () => {
    const c = await ctx();
    await handleLog(
      {
        ...base,
        delegations: {
          ts: "2026-07-15T10:00:00.000Z",
          agent: "x",
        } as unknown as LogEntry["delegations"],
      },
      c,
    );
    expect(await lines(c.paths.delegationLog)).toHaveLength(1);
  });

  it("a delegations-only post (zero tokens) skips the token log", async () => {
    const c = await ctx();
    await handleLog(
      {
        ...base,
        input_tokens: 0,
        output_tokens: 0,
        delegations: [{ ts: "2026-07-15T10:00:00.000Z" }],
      },
      c,
    );
    expect(await lines(c.paths.tokenLog)).toHaveLength(0);
    expect(await lines(c.paths.delegationLog)).toHaveLength(1);
  });

  it("drops malformed delegation events (missing ts) but keeps valid ones", async () => {
    const c = await ctx();
    await handleLog(
      {
        ...base,
        delegations: [
          { ts: "" },
          { agent: "y" } as unknown as { ts: string },
          { ts: "2026-07-15T10:00:00.000Z", agent: "y" },
        ],
      },
      c,
    );
    expect(await lines(c.paths.delegationLog)).toHaveLength(1);
  });

  it("still rejects entries without token numbers", async () => {
    const c = await ctx();
    await expect(handleLog({ model: "m", project: "p" } as unknown as LogEntry, c)).rejects.toThrow(
      /input_tokens/,
    );
  });
});
