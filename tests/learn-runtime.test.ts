// v0.26 — the usage aggregate is a CACHE of an append-only log, and must behave
// like one. Before this it only replayed the log when it was completely empty,
// so a store clobbered by an older writer kept some files, passed the
// empty-check, and served a ranking built on partial history forever.

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LearnRuntime } from "../src/learn/runtime.js";
import { readLearnStore, writeLearnStore } from "../src/learn/store.js";
import {
  latestEventTs,
  mergeStores,
  LEARN_SCHEMA_VERSION,
  type AccessEvent,
  type LearnStore,
} from "../src/learn/usage.js";

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function paths() {
  const dir = await mkdtemp(join(tmpdir(), "syn-learn-"));
  return { logPath: join(dir, "access_log.jsonl"), storePath: join(dir, "learn_store.json") };
}

const writeLog = (p: string, events: AccessEvent[]) =>
  writeFile(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

describe("LearnRuntime.load", () => {
  it("replays the log when the aggregate is STALE, not just when it's empty", async () => {
    const { logPath, storePath } = await paths();
    await writeLog(logPath, [
      { ts: iso(-2000), path: "src/a.ts", source: "read" },
      { ts: iso(-1000), path: "src/b.ts", source: "read" },
    ]);
    // A store that kept one path but missed the rest — exactly what a clobber
    // leaves behind. Non-empty, so the old empty-check accepted it as current.
    await writeFile(
      storePath,
      JSON.stringify({
        schema_version: LEARN_SCHEMA_VERSION,
        asOf: iso(-5000),
        files: { "src/a.ts": { count: 1, decayed: 1, lastTs: iso(-2000) } },
      }),
      "utf8",
    );

    const rt = await LearnRuntime.load(logPath, storePath);
    const scores = rt.effectiveScores();
    expect(scores.has("src/a.ts")).toBe(true);
    expect(scores.has("src/b.ts")).toBe(true); // recovered from the log
  });

  it("keeps a store that is already current (no needless replay)", async () => {
    const { logPath, storePath } = await paths();
    await writeLog(logPath, [{ ts: iso(-3000), path: "src/a.ts", source: "read" }]);
    // asOf is newer than every event, so the aggregate has folded them all.
    await writeFile(
      storePath,
      JSON.stringify({
        schema_version: LEARN_SCHEMA_VERSION,
        asOf: iso(0),
        files: { "kept-only-in-store.ts": { count: 9, decayed: 9, lastTs: iso(-1000) } },
      }),
      "utf8",
    );

    const rt = await LearnRuntime.load(logPath, storePath);
    // A replay would have wiped this path, since it isn't in the log.
    expect(rt.effectiveScores().has("kept-only-in-store.ts")).toBe(true);
  });

  it("starts empty with no log and no store", async () => {
    const { logPath, storePath } = await paths();
    const rt = await LearnRuntime.load(logPath, storePath);
    expect(rt.effectiveScores().size).toBe(0);
  });
});

describe("latestEventTs", () => {
  it("finds the newest timestamp and ignores unparseable ones", () => {
    expect(latestEventTs([])).toBeNull();
    expect(
      latestEventTs([
        { ts: "2026-01-01T00:00:00.000Z", path: "a", source: "read" },
        { ts: "not-a-date", path: "b", source: "read" },
        { ts: "2026-06-01T00:00:00.000Z", path: "c", source: "read" },
      ]),
    ).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("mergeStores", () => {
  const store = (files: LearnStore["files"], asOf: string): LearnStore => ({
    schema_version: LEARN_SCHEMA_VERSION,
    asOf,
    files,
  });

  it("keeps paths only the other side knows about", () => {
    const merged = mergeStores(
      store({ "a.ts": { count: 1, decayed: 1, lastTs: iso(-1000) } }, iso(0)),
      store({ "b.ts": { count: 5, decayed: 5, lastTs: iso(-1000) } }, iso(-500)),
    );
    expect(Object.keys(merged.files).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps the entry that folded the more recent event", () => {
    const merged = mergeStores(
      store({ "a.ts": { count: 1, decayed: 1, lastTs: "2026-01-01T00:00:00.000Z" } }, iso(0)),
      store({ "a.ts": { count: 9, decayed: 9, lastTs: "2026-06-01T00:00:00.000Z" } }, iso(0)),
    );
    expect(merged.files["a.ts"]?.count).toBe(9);
  });
});

describe("writeLearnStore", () => {
  it("merges against disk instead of overwriting it", async () => {
    // Our in-memory copy was loaded at startup; another writer has learned a
    // path since. A whole-file write would silently drop it.
    const { storePath } = await paths();
    await writeFile(
      storePath,
      JSON.stringify({
        schema_version: LEARN_SCHEMA_VERSION,
        asOf: iso(-1000),
        files: { "theirs.ts": { count: 3, decayed: 3, lastTs: iso(-1000) } },
      }),
      "utf8",
    );

    await writeLearnStore(storePath, {
      schema_version: LEARN_SCHEMA_VERSION,
      asOf: iso(0),
      files: { "ours.ts": { count: 1, decayed: 1, lastTs: iso(0) } },
    });

    const onDisk = await readLearnStore(storePath);
    expect(Object.keys(onDisk.files).sort()).toEqual(["ours.ts", "theirs.ts"]);
  });
});
