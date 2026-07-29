// Reads/writes info_graph.json and symbol_index.json.
//
// Unlike Synthra's other state, a damaged graph loses nothing — it's rebuilt from
// the filesystem by a scan. So these readers report `missing` vs `corrupt` and let
// the caller quarantine and rescan, instead of throwing a fatal "Run `syn scan`
// first" that refused to start the server over a file it could have regenerated.

import { quarantineFile, readJsonFile, writeJsonAtomic } from "../shared/json-store.js";
import type { GraphSchema, SymbolIndex } from "./types.js";

export async function writeGraph(path: string, graph: GraphSchema): Promise<void> {
  // Pretty-printing a graph with full file contents balloons disk size and
  // the JSON is only ever read by machines; keep it compact.
  await writeJsonAtomic(path, graph, { pretty: false });
}

/** Null when absent or unreadable — the caller rescans either way. Quarantines a
 *  corrupt file first so it's available for diagnosis. */
export async function readGraph(path: string): Promise<GraphSchema | null> {
  const read = await readJsonFile<GraphSchema>(path);
  if (read.status === "ok") return read.data;
  if (read.status === "corrupt") await quarantineFile(path);
  return null;
}

export async function writeSymbolIndex(path: string, index: SymbolIndex): Promise<void> {
  await writeJsonAtomic(path, index);
}

export async function readSymbolIndex(path: string): Promise<SymbolIndex | null> {
  const read = await readJsonFile<SymbolIndex>(path);
  if (read.status !== "ok") {
    if (read.status === "corrupt") await quarantineFile(path);
    return null;
  }
  // Re-home onto a null prototype so name lookups (e.g. index["toString"])
  // never resolve to an inherited Object.prototype member. Mirrors
  // buildSymbolIndex, which builds the index the same way.
  return Object.assign(Object.create(null), read.data);
}
