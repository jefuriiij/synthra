// The safety net under every JSON state file: missing vs corrupt reads, atomic
// writes, and read-modify-write that can't lose a concurrent update. These are
// the invariants the data-loss fixes depend on.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  quarantineFile,
  readJsonFile,
  updateJsonFile,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/shared/json-store.js";

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "syn-store-"));
}

describe("readJsonFile", () => {
  it("reads valid JSON", async () => {
    const p = join(await tmpDir(), "a.json");
    await writeFile(p, '{"n":1}', "utf8");
    expect(await readJsonFile<{ n: number }>(p)).toEqual({ status: "ok", data: { n: 1 } });
  });

  it("reports an absent file as missing, not corrupt", async () => {
    const r = await readJsonFile(join(await tmpDir(), "nope.json"));
    expect(r.status).toBe("missing");
  });

  // A crashed writeFile leaves zero bytes. There's nothing in it to lose, so it
  // must be safe to overwrite — otherwise a first run could wedge permanently.
  it("treats an empty or whitespace-only file as missing", async () => {
    const dir = await tmpDir();
    for (const [name, body] of [
      ["empty.json", ""],
      ["blank.json", "  \n "],
    ]) {
      const p = join(dir, name as string);
      await writeFile(p, body as string, "utf8");
      expect((await readJsonFile(p)).status).toBe("missing");
    }
  });

  it("reports a file that exists but won't parse as corrupt", async () => {
    const p = join(await tmpDir(), "bad.json");
    await writeFile(p, '{"n":1', "utf8"); // truncated mid-object
    const r = await readJsonFile(p);
    expect(r.status).toBe("corrupt");
    expect(r.status === "corrupt" && r.error.length).toBeGreaterThan(0);
  });
});

describe("quarantineFile", () => {
  it("moves the file aside and returns the new path, losing nothing", async () => {
    const dir = await tmpDir();
    const p = join(dir, "store.json");
    await writeFile(p, "PRECIOUS BUT BROKEN", "utf8");

    const moved = await quarantineFile(p);
    expect(moved).toBeTruthy();
    expect(await readFile(moved as string, "utf8")).toBe("PRECIOUS BUT BROKEN");
    // the original is gone from its old name, so a fresh start can be written
    await expect(stat(p)).rejects.toThrow();
  });

  it("does not pile up copies when called repeatedly", async () => {
    const dir = await tmpDir();
    const p = join(dir, "store.json");
    await writeFile(p, "one", "utf8");
    await quarantineFile(p);
    await writeFile(p, "two", "utf8");
    expect(await quarantineFile(p)).toBeNull(); // within the window — skipped
    const copies = (await readdir(dir)).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
  });

  it("returns null for a file that isn't there", async () => {
    expect(await quarantineFile(join(await tmpDir(), "ghost.json"))).toBeNull();
  });
});

describe("writeJsonAtomic / writeTextAtomic", () => {
  it("writes house format: 2-space JSON with a trailing newline", async () => {
    const p = join(await tmpDir(), "out.json");
    await writeJsonAtomic(p, { a: 1 });
    expect(await readFile(p, "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  it("writes compact JSON when asked", async () => {
    const p = join(await tmpDir(), "compact.json");
    await writeJsonAtomic(p, { a: 1 }, { pretty: false });
    expect(await readFile(p, "utf8")).toBe('{"a":1}\n');
  });

  it("creates missing parent directories", async () => {
    const p = join(await tmpDir(), "deep", "deeper", "out.json");
    await writeJsonAtomic(p, { ok: true });
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ ok: true });
  });

  it("leaves no temp file behind", async () => {
    const dir = await tmpDir();
    await writeJsonAtomic(join(dir, "a.json"), { a: 1 });
    await writeTextAtomic(join(dir, "b.md"), "# hi\n");
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces an existing file wholesale", async () => {
    const p = join(await tmpDir(), "over.json");
    await writeJsonAtomic(p, { long: "x".repeat(500) });
    await writeJsonAtomic(p, { short: 1 });
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ short: 1 });
  });
});

describe("updateJsonFile", () => {
  interface Store {
    items: string[];
  }
  const init = (): Store => ({ items: [] });

  it("starts from init() when the file is absent", async () => {
    const p = join(await tmpDir(), "s.json");
    const r = await updateJsonFile<Store>(p, init, (cur) => ({ items: [...cur.items, "a"] }));
    expect(r.status).toBe("written");
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ items: ["a"] });
  });

  it("appends to existing content", async () => {
    const p = join(await tmpDir(), "s.json");
    await writeJsonAtomic(p, { items: ["a", "b"] });
    await updateJsonFile<Store>(p, init, (cur) => ({ items: [...cur.items, "c"] }));
    expect(JSON.parse(await readFile(p, "utf8")).items).toEqual(["a", "b", "c"]);
  });

  // THE point of this module: a corrupt file is set aside and never replaced by
  // a degraded-to-empty version of itself.
  it("quarantines a corrupt file and writes nothing", async () => {
    const dir = await tmpDir();
    const p = join(dir, "s.json");
    await writeFile(p, '{"items":["a","b","c"', "utf8"); // truncated

    const r = await updateJsonFile<Store>(p, init, (cur) => ({ items: [...cur.items, "d"] }));
    expect(r.status).toBe("corrupt");
    expect(r.status === "corrupt" && r.quarantined).toBeTruthy();

    // no 1-entry replacement was written at the original path
    await expect(stat(p)).rejects.toThrow();
    // ...and the damaged content is still recoverable
    const copy = (await readdir(dir)).find((n) => n.includes(".corrupt-"));
    expect(await readFile(join(dir, copy as string), "utf8")).toContain('"a","b","c"');
  });

  it("skips the write entirely when mutate returns null", async () => {
    const p = join(await tmpDir(), "s.json");
    await writeJsonAtomic(p, { items: ["a"] });
    const before = (await stat(p)).mtimeMs;
    const r = await updateJsonFile<Store>(p, init, () => null);
    expect(r.status).toBe("unchanged");
    expect((await stat(p)).mtimeMs).toBe(before); // untouched
  });

  it("does not create a file when mutate returns null on a missing one", async () => {
    const p = join(await tmpDir(), "s.json");
    expect((await updateJsonFile<Store>(p, init, () => null)).status).toBe("unchanged");
    await expect(stat(p)).rejects.toThrow();
  });

  // The lost update this replaces: two readers both see the pre-state and the
  // second write drops the first. Here the mutation is redone against what
  // actually landed, so both survive.
  // The lost update this exists to prevent: two callers both read the pre-state
  // and the second write drops the first. Both mutations must survive.
  //
  // This case also caught a real bug — concurrent calls shared one temp filename,
  // so one renamed the OTHER's content into place and the loser then re-applied
  // its mutation on top, yielding ["y","y"] instead of ["x","y"].
  it("keeps both mutations when two updates run concurrently", async () => {
    const p = join(await tmpDir(), "s.json");
    await writeJsonAtomic(p, { items: [] });

    await Promise.all([
      updateJsonFile<Store>(p, init, (cur) => ({ items: [...cur.items, "x"] })),
      updateJsonFile<Store>(p, init, (cur) => ({ items: [...cur.items, "y"] })),
    ]);

    const items = JSON.parse(await readFile(p, "utf8")).items as string[];
    expect([...items].sort()).toEqual(["x", "y"]);
  });

  it("survives a burst of concurrent updates without losing any", async () => {
    const p = join(await tmpDir(), "burst.json");
    await writeJsonAtomic(p, { items: [] });
    const letters = ["a", "b", "c", "d", "e"];
    await Promise.all(
      letters.map((l) => updateJsonFile<Store>(p, init, (cur) => ({ items: [...cur.items, l] }))),
    );
    const items = JSON.parse(await readFile(p, "utf8")).items as string[];
    expect([...items].sort()).toEqual(letters);
  });

  it("keeps a nested store's directory creation working", async () => {
    const p = join(await tmpDir(), "branches", "feature", "store.json");
    const r = await updateJsonFile<Store>(p, init, (cur) => ({ items: [...cur.items, "a"] }));
    expect(r.status).toBe("written");
    expect(JSON.parse(await readFile(p, "utf8")).items).toEqual(["a"]);
  });
});
