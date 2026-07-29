// The graph is the one piece of Synthra state that is fully derived — a scan
// rebuilds it from the filesystem. So a damaged graph should cost time, not the
// ability to start: readGraph used to throw, and http.ts turned that into a fatal
// "Run `syn scan` first" that refused to boot over a file it could regenerate.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readGraph, readSymbolIndex, writeGraph, writeSymbolIndex } from "../src/graph/store.js";
import type { GraphSchema, SymbolIndex } from "../src/graph/types.js";

const GRAPH: GraphSchema = {
  schema_version: 2,
  generated_at: "2026-07-29T00:00:00.000Z",
  root: "C:\\proj",
  file_count: 1,
  symbol_count: 1,
  edge_count: 0,
  files: [],
  edges: [],
};

async function dir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "syn-graph-"));
}

describe("readGraph", () => {
  it("round-trips a graph", async () => {
    const p = join(await dir(), "info_graph.json");
    await writeGraph(p, GRAPH);
    expect((await readGraph(p))?.symbol_count).toBe(1);
  });

  it("writes compact JSON — file bodies make pretty-printing expensive", async () => {
    const p = join(await dir(), "info_graph.json");
    await writeGraph(p, GRAPH);
    const raw = await readFile(p, "utf8");
    expect(raw.startsWith('{"schema_version":2')).toBe(true);
  });

  it("returns null for a missing graph rather than throwing", async () => {
    expect(await readGraph(join(await dir(), "nope.json"))).toBeNull();
  });

  // The behavior change: a torn graph is recoverable state, so it's set aside and
  // reported as absent, which the caller answers with a rescan.
  it("quarantines a damaged graph and reports it as absent", async () => {
    const d = await dir();
    const p = join(d, "info_graph.json");
    await writeFile(p, '{"schema_version":2,"files":[{"path":"a.ts"', "utf8");

    expect(await readGraph(p)).toBeNull();

    const copies = (await readdir(d)).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
    expect(await readFile(join(d, copies[0] as string), "utf8")).toContain("a.ts");
    expect((await readdir(d)).includes("info_graph.json")).toBe(false);
  });
});

describe("readSymbolIndex", () => {
  it("round-trips and keeps a null prototype so names can't hit Object.prototype", async () => {
    const p = join(await dir(), "symbol_index.json");
    const index: SymbolIndex = Object.assign(Object.create(null), { mySymbol: [] });
    await writeSymbolIndex(p, index);
    const read = await readSymbolIndex(p);
    expect(read).not.toBeNull();
    // the classic trap: a symbol literally named "toString"
    expect((read as SymbolIndex)["toString"]).toBeUndefined();
    expect(Object.getPrototypeOf(read as object)).toBeNull();
  });

  it("returns null for a missing or damaged index", async () => {
    const d = await dir();
    expect(await readSymbolIndex(join(d, "gone.json"))).toBeNull();
    const p = join(d, "symbol_index.json");
    await writeFile(p, "{ nope", "utf8");
    expect(await readSymbolIndex(p)).toBeNull();
    expect((await readdir(d)).some((n) => n.includes(".corrupt-"))).toBe(true);
  });
});
