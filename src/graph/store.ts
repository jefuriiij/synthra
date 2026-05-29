// Reads/writes info_graph.json and symbol_index.json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { GraphSchema, SymbolIndex } from "./types.js";

async function writeJson(path: string, data: unknown, pretty: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await writeFile(path, text + "\n", "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as T;
}

export async function writeGraph(path: string, graph: GraphSchema): Promise<void> {
  // Pretty-printing a graph with full file contents balloons disk size and
  // the JSON is only ever read by machines; keep it compact.
  await writeJson(path, graph, false);
}

export async function readGraph(path: string): Promise<GraphSchema> {
  return readJson<GraphSchema>(path);
}

export async function writeSymbolIndex(path: string, index: SymbolIndex): Promise<void> {
  await writeJson(path, index, true);
}

export async function readSymbolIndex(path: string): Promise<SymbolIndex> {
  // Re-home onto a null prototype so name lookups (e.g. index["toString"])
  // never resolve to an inherited Object.prototype member. Mirrors
  // buildSymbolIndex, which builds the index the same way.
  const parsed = await readJson<SymbolIndex>(path);
  return Object.assign(Object.create(null), parsed);
}
