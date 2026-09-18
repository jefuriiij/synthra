// activity.jsonl is the largest file Synthra writes — 3.4 MB / 26.5k lines
// across 13 projects after 113 days — and nothing ever reads it back. Queries
// are served from the in-memory ring in ActivityStore; the file exists only for
// eyeball debugging. Left uncapped it is pure write amplification.
//
// These tests pin the cap and, more importantly, the two ways truncation can go
// wrong: losing the newest events, or cutting mid-line and leaving a corrupt
// JSONL tail that every future reader has to skip.

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";

async function logFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "syn-act-")), "activity.jsonl");
}

const save = (i: number) =>
  ({ kind: "save", path: `src/file${i}.ts`, ts: new Date().toISOString() }) as const;

describe("ActivityStore disk cap", () => {
  it("keeps a small log completely intact", async () => {
    const f = await logFile();
    const store = new ActivityStore(f, 100, 1024 * 1024);
    await store.add(save(1));
    await store.add(save(2));
    const lines = (await readFile(f, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("bounds the file once the cap is exceeded", async () => {
    const f = await logFile();
    const store = new ActivityStore(f, 100, 2048);
    for (let i = 0; i < 400; i++) await store.add(save(i));
    const size = (await readFile(f, "utf8")).length;
    // Truncation halves rather than trimming to exactly the cap, so the steady
    // state is (cap/2, cap]; never unbounded.
    expect(size).toBeLessThanOrEqual(2048);
  });

  it("keeps the NEWEST events, not the oldest", async () => {
    const f = await logFile();
    const store = new ActivityStore(f, 100, 2048);
    for (let i = 0; i < 400; i++) await store.add(save(i));
    const txt = await readFile(f, "utf8");
    expect(txt).toContain("file399.ts");
    expect(txt).not.toContain("file0.ts");
  });

  it("never leaves a partial line behind", async () => {
    const f = await logFile();
    const store = new ActivityStore(f, 100, 2048);
    for (let i = 0; i < 400; i++) await store.add(save(i));
    for (const line of (await readFile(f, "utf8")).split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("does not corrupt a pre-existing log that has no newline boundary", async () => {
    // Pathological input: one enormous line, larger than the cap, with no way
    // to cut safely. Leaving it alone beats writing a broken tail.
    const f = await logFile();
    await writeFile(f, `{"kind":"save","path":"${"x".repeat(4000)}","ts":"t"}`, "utf8");
    const store = new ActivityStore(f, 100, 2048);
    await store.add(save(1));
    const lines = (await readFile(f, "utf8")).split("\n").filter(Boolean);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("still answers queries from the ring after the file is truncated", async () => {
    // The cap must not touch in-memory behaviour — that is what actually
    // serves recent_activity.
    const f = await logFile();
    const store = new ActivityStore(f, 10, 512);
    for (let i = 0; i < 200; i++) await store.add(save(i));
    expect(store.size()).toBe(10);
    expect(store.getEvents()).toHaveLength(10);
  });
});
