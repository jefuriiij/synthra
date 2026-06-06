// Session snapshot read/write (machine-local, schema-guarded).

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readSession,
  writeSession,
  SESSION_SCHEMA_VERSION,
  type SessionState,
} from "../src/memory/session.js";

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syn-session-"));
  return join(dir, "session.json");
}

const SNAP: SessionState = {
  schema_version: SESSION_SCHEMA_VERSION,
  endedAt: "2026-06-06T12:00:00.000Z",
  branch: "main",
  filesTouched: ["src/auth.ts", "src/session.ts"],
  recentCommits: [{ hash: "abc1234", message: "fix auth", date: "2026-06-06T11:00:00.000Z" }],
  summary: {
    tasks: ["wiring login"],
    decisions: ["use jq not sed"],
    next: ["add refresh rotation"],
  },
};

describe("session snapshot", () => {
  it("round-trips a snapshot", async () => {
    const path = await tmp();
    await writeSession(path, SNAP);
    expect(await readSession(path)).toEqual(SNAP);
  });

  it("returns null when no snapshot exists", async () => {
    expect(await readSession(await tmp())).toBeNull();
  });

  it("returns null on corrupt JSON", async () => {
    const path = await tmp();
    await writeFile(path, "{ not json", "utf8");
    expect(await readSession(path)).toBeNull();
  });

  it("returns null on a schema-version mismatch (no migration)", async () => {
    const path = await tmp();
    await writeFile(path, JSON.stringify({ ...SNAP, schema_version: 999 }), "utf8");
    expect(await readSession(path)).toBeNull();
  });
});
