// Usage-learning store I/O (best-effort, schema-guarded).

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendAccess,
  readAccessLog,
  readLearnStore,
  writeLearnStore,
} from "../src/learn/store.js";
import { emptyStore, foldEvent, type AccessEvent } from "../src/learn/usage.js";

async function tmp(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syn-learn-"));
  return join(dir, name);
}

describe("learn store I/O", () => {
  it("round-trips a store", async () => {
    const path = await tmp("learn_store.json");
    const store = foldEvent(emptyStore(), {
      ts: "2026-01-01T00:00:00.000Z",
      path: "src/a.ts",
      source: "read",
    });
    await writeLearnStore(path, store);
    const back = await readLearnStore(path);
    expect(back.files["src/a.ts"]?.count).toBe(1);
  });

  it("returns an empty store for a missing file", async () => {
    const path = await tmp("nope.json");
    expect(Object.keys((await readLearnStore(path)).files)).toHaveLength(0);
  });

  it("returns an empty store for corrupt JSON", async () => {
    const path = await tmp("learn_store.json");
    await writeFile(path, "{ not json", "utf8");
    expect(Object.keys((await readLearnStore(path)).files)).toHaveLength(0);
  });

  it("returns an empty store on a schema-version mismatch", async () => {
    const path = await tmp("learn_store.json");
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 999,
        asOf: "x",
        files: { "a.ts": { count: 9, decayed: 9, lastTs: "x" } },
      }),
      "utf8",
    );
    expect(Object.keys((await readLearnStore(path)).files)).toHaveLength(0);
  });
});

describe("access log I/O", () => {
  it("appends and reads JSONL, skipping malformed lines", async () => {
    const path = await tmp("access_log.jsonl");
    const a: AccessEvent = { ts: "2026-01-01T00:00:00.000Z", path: "src/a.ts", source: "read" };
    const b: AccessEvent = {
      ts: "2026-01-01T00:01:00.000Z",
      path: "src/b.ts",
      source: "register_edit",
    };

    await appendAccess(path, a);
    // Splice in a malformed line between two valid ones.
    await writeFile(path, (await readFile(path, "utf8")) + "{ broken\n", "utf8");
    await appendAccess(path, b);

    const rows = await readAccessLog(path);
    expect(rows.map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns [] for a missing log", async () => {
    expect(await readAccessLog(await tmp("none.jsonl"))).toEqual([]);
  });
});
