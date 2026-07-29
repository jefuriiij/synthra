// The context store is branch-aware memory in .synthra/ — GIT-TRACKED, so a
// mistake here gets committed. It used to read a damaged store as `[]`, which
// then (a) persisted a 1-entry store over everything that was really in there
// and (b) rewrote CONTEXT.md to say there were no entries.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEntry,
  readStore,
  writeEntries,
  type ContextEntry,
} from "../src/memory/context-store.js";
import { rememberEntry, refreshContextMd, recallEntries } from "../src/memory/index.js";
import { resolvePaths } from "../src/shared/paths.js";

function entry(content: string): ContextEntry {
  return { type: "decision", content, tags: [], files: [], date: "2026-07-29T00:00:00.000Z" };
}

async function storeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "syn-ctx-"));
}

describe("readStore", () => {
  it("reads an absent store as empty, not corrupt", async () => {
    const r = await readStore(join(await storeDir(), "context-store.json"));
    expect(r).toEqual({ status: "ok", entries: [] });
  });

  it("reads real entries back", async () => {
    const p = join(await storeDir(), "context-store.json");
    await writeEntries(p, [entry("a"), entry("b")]);
    const r = await readStore(p);
    expect(r.status === "ok" && r.entries.map((e) => e.content)).toEqual(["a", "b"]);
  });

  it("reports a damaged store as corrupt instead of empty", async () => {
    const p = join(await storeDir(), "context-store.json");
    await writeFile(p, '{"schema_version":1,"entries":[{"type":"decis', "utf8");
    expect((await readStore(p)).status).toBe("corrupt");
  });

  it("treats a parseable file with no entries array as empty", async () => {
    const p = join(await storeDir(), "context-store.json");
    await writeFile(p, '{"schema_version":1}', "utf8");
    expect(await readStore(p)).toEqual({ status: "ok", entries: [] });
  });
});

describe("appendEntry", () => {
  it("appends to an existing store", async () => {
    const p = join(await storeDir(), "context-store.json");
    await writeEntries(p, [entry("first")]);
    const r = await appendEntry(p, entry("second"));
    expect(r.status).toBe("written");
    const read = await readStore(p);
    expect(read.status === "ok" && read.entries.map((e) => e.content)).toEqual(["first", "second"]);
  });

  // THE regression: 71 real entries must not become 1.
  it("refuses to replace a damaged store, and quarantines it", async () => {
    const dir = await storeDir();
    const p = join(dir, "context-store.json");
    const realish = JSON.stringify({
      schema_version: 1,
      entries: Array.from({ length: 71 }, (_, i) => entry(`decision ${i}`)),
    });
    await writeFile(p, `${realish.slice(0, -40)}`, "utf8"); // truncated mid-entry

    const r = await appendEntry(p, entry("new thing"));
    expect(r.status).toBe("corrupt");

    // the damaged original is recoverable, and nothing replaced it
    const copies = (await readdir(dir)).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
    expect(await readFile(join(dir, copies[0] as string), "utf8")).toContain("decision 70");
    expect((await readdir(dir)).includes("context-store.json")).toBe(false);
  });

  it("keeps concurrent appends from losing each other", async () => {
    const p = join(await storeDir(), "context-store.json");
    await writeEntries(p, []);
    await Promise.all([appendEntry(p, entry("x")), appendEntry(p, entry("y"))]);
    const read = await readStore(p);
    expect(read.status === "ok" && read.entries.map((e) => e.content).sort()).toEqual(["x", "y"]);
  });
});

describe("rememberEntry / refreshContextMd with a damaged store", () => {
  async function damagedProject() {
    const root = await mkdtemp(join(tmpdir(), "syn-ctx-proj-"));
    const paths = resolvePaths(root);
    // default branch → store sits directly in .synthra/
    await writeEntries(paths.contextStore, [entry("kept one"), entry("kept two")]);
    const good = await readFile(paths.contextStore, "utf8");
    await refreshContextMd(paths); // produce a real CONTEXT.md first
    const md = await readFile(paths.contextMd, "utf8");
    await writeFile(paths.contextStore, good.slice(0, 60), "utf8"); // truncate
    return { paths, md };
  }

  it("does not rewrite the git-tracked CONTEXT.md from an unreadable store", async () => {
    const { paths, md } = await damagedProject();
    const r = await refreshContextMd(paths);
    expect(r.unreadable).toBeTruthy();
    expect(r.entriesSeen).toBe(0);
    // the narrative is untouched — no "no context entries yet" replacement
    expect(await readFile(paths.contextMd, "utf8")).toBe(md);
  });

  it("reports rather than saves when remembering into a damaged store", async () => {
    const { paths, md } = await damagedProject();
    const r = await rememberEntry(paths, { text: "a new decision", kind: "decision" });
    expect(r.unreadable).toBeTruthy();
    expect(await readFile(paths.contextMd, "utf8")).toBe(md);
  });

  it("tells recall the store is unreadable instead of implying it's empty", async () => {
    const { paths } = await damagedProject();
    const r = await recallEntries(paths);
    expect(r.entries).toEqual([]);
    expect(r.unreadable).toBeTruthy();
  });
});
