// Incremental parse cache: cache I/O + the core invariant — an incremental scan
// (reuse unchanged files) produces a graph identical to a full from-scratch scan.

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildGraph } from "../src/scanner/extract.js";
import {
  emptyParseCache,
  incrementalParse,
  readParseCache,
  writeParseCache,
} from "../src/scanner/parse-cache.js";
import type { WalkedFile } from "../src/scanner/walker.js";
import type { GraphSchema } from "../src/graph/types.js";

async function mkProject(
  files: Record<string, string>,
): Promise<{ root: string; walked: WalkedFile[] }> {
  const root = await mkdtemp(join(tmpdir(), "syn-pc-"));
  const walked: WalkedFile[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    walked.push({
      absPath: abs,
      relPath: rel,
      ext: rel.slice(rel.lastIndexOf(".")),
      size: content.length,
    });
  }
  return { root, walked };
}

// Graphs differ only by their generated_at timestamp between runs — normalize it.
function normalize(g: GraphSchema): GraphSchema {
  return { ...g, generated_at: "" };
}

describe("parse cache I/O", () => {
  it("round-trips and rejects a version mismatch", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "syn-pc-io-")), "parse_cache.json");
    const cache = emptyParseCache();
    cache.files["src/a.ts"] = { hash: "abc123", symbols: [], imports: [], calls: [] };
    await writeParseCache(path, cache);
    expect((await readParseCache(path)).files["src/a.ts"]?.hash).toBe("abc123");

    await writeFile(path, JSON.stringify({ schema_version: 999, files: { x: {} } }), "utf8");
    expect(Object.keys((await readParseCache(path)).files)).toHaveLength(0);
  });

  it("returns an empty cache for a missing file", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "syn-pc-io-")), "none.json");
    expect(Object.keys((await readParseCache(path)).files)).toHaveLength(0);
  });
});

describe("incrementalParse", () => {
  it("reuses unchanged files on a second pass and yields an identical graph", async () => {
    const { root, walked } = await mkProject({
      "src/a.ts": 'import { b } from "./b";\nexport function a() {\n  return b();\n}\n',
      "src/b.ts": "export function b() {\n  return 1;\n}\n",
    });

    const first = await incrementalParse(walked, emptyParseCache());
    expect(first.reparsed).toBe(2);
    expect(first.reused).toBe(0);
    const g1 = await buildGraph(root, first.parsed);

    const second = await incrementalParse(walked, first.cache);
    expect(second.reused).toBe(2);
    expect(second.reparsed).toBe(0);
    const g2 = await buildGraph(root, second.parsed);

    // Same nodes, edges, counts — only generated_at differs.
    expect(normalize(g2)).toEqual(normalize(g1));
    // Sanity: the import edge actually exists (proves cached imports survived).
    expect(g2.edges.some((e) => e.kind === "imports")).toBe(true);
  });

  it("re-parses only the changed file; result matches a full parse of the new state", async () => {
    const { root, walked } = await mkProject({
      "src/a.ts": "export function a() {\n  return 1;\n}\n",
      "src/b.ts": "export function b() {\n  return 2;\n}\n",
    });
    const first = await incrementalParse(walked, emptyParseCache());

    const newB = "export function b2() {\n  return 22;\n}\n";
    await writeFile(join(root, "src/b.ts"), newB, "utf8");
    const walked2 = walked.map((w) => (w.relPath === "src/b.ts" ? { ...w, size: newB.length } : w));

    const inc = await incrementalParse(walked2, first.cache);
    expect(inc.reused).toBe(1); // a.ts
    expect(inc.reparsed).toBe(1); // b.ts changed
    const gInc = await buildGraph(root, inc.parsed);

    const fresh = await incrementalParse(walked2, emptyParseCache());
    const gFull = await buildGraph(root, fresh.parsed);
    expect(normalize(gInc)).toEqual(normalize(gFull));

    const names = gInc.nodes.filter((n) => n.kind === "symbol").map((n) => n.name);
    expect(names).toContain("b2");
    expect(names).not.toContain("b");
  });

  it("drops deleted files from the parsed set and the cache", async () => {
    const { walked } = await mkProject({
      "src/a.ts": "export function a() {}\n",
      "src/b.ts": "export function b() {}\n",
    });
    const first = await incrementalParse(walked, emptyParseCache());

    const walked2 = walked.filter((w) => w.relPath !== "src/b.ts"); // b.ts deleted
    const inc = await incrementalParse(walked2, first.cache);
    expect(inc.parsed.map((p) => p.file.relPath)).toEqual(["src/a.ts"]);
    expect(Object.keys(inc.cache.files)).toEqual(["src/a.ts"]);
    expect(inc.reused).toBe(1);
  });

  it("full:true ignores the cache and re-parses everything", async () => {
    const { walked } = await mkProject({ "src/a.ts": "export function a() {}\n" });
    const first = await incrementalParse(walked, emptyParseCache());
    const forced = await incrementalParse(walked, first.cache, { full: true });
    expect(forced.reparsed).toBe(1);
    expect(forced.reused).toBe(0);
  });
});
