// heartbeat.json: when each hook last reached a project's server. The
// dashboard's health table reads it to catch a hook that stopped quietly.

import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WRITE_EVERY_MS,
  flushHeartbeat,
  noteHook,
  readHeartbeat,
} from "../src/server/heartbeat.js";

const T0 = Date.parse("2026-10-02T10:00:00.000Z");

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "syn-beat-")), ".synthra-graph", "heartbeat.json");
}

describe("heartbeat", () => {
  it("writes each hook the first time it is seen, with the version", async () => {
    const f = await file();
    noteHook(f, "start", "0.34.0", T0);
    await flushHeartbeat(f);
    noteHook(f, "reply", "0.34.0", T0 + 1000);
    await flushHeartbeat(f);
    expect(await readHeartbeat(f)).toEqual({
      version: "0.34.0",
      hooks: { start: new Date(T0).toISOString(), reply: new Date(T0 + 1000).toISOString() },
    });
  });

  // The gate fires on every tool call; one write per window is enough.
  it("writes a repeat beat only once the window has passed", async () => {
    const f = await file();
    noteHook(f, "tools", "0.34.0", T0);
    await flushHeartbeat(f);
    noteHook(f, "tools", "0.34.0", T0 + 5000);
    await flushHeartbeat(f);
    expect((await readHeartbeat(f))?.hooks.tools).toBe(new Date(T0).toISOString());

    noteHook(f, "tools", "0.34.0", T0 + WRITE_EVERY_MS + 1);
    await flushHeartbeat(f);
    expect((await readHeartbeat(f))?.hooks.tools).toBe(
      new Date(T0 + WRITE_EVERY_MS + 1).toISOString(),
    );
  });

  it("keeps the times another process wrote", async () => {
    const f = await file();
    noteHook(f, "start", "0.34.0", T0);
    await flushHeartbeat(f);
    const other = new Date(T0 - 60_000).toISOString();
    await writeFile(
      f,
      JSON.stringify({
        version: "0.34.0",
        hooks: { start: new Date(T0).toISOString(), prompt: other },
      }),
    );
    noteHook(f, "reply", "0.34.0", T0 + 1000);
    await flushHeartbeat(f);
    expect((await readHeartbeat(f))?.hooks.prompt).toBe(other);
  });

  it("reads a missing or damaged file as nothing", async () => {
    const f = await file();
    expect(await readHeartbeat(f)).toBeNull();
  });
});
