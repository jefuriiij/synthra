// Reads/writes info_graph.json and symbol_index.json.
// TODO: M1

import type { GraphSchema, SymbolIndex } from "./types.js";

export async function writeGraph(_path: string, _graph: GraphSchema): Promise<void> {
  throw new Error("Synthra: writeGraph not yet implemented (M1)");
}

export async function readGraph(_path: string): Promise<GraphSchema> {
  throw new Error("Synthra: readGraph not yet implemented (M1)");
}

export async function writeSymbolIndex(_path: string, _index: SymbolIndex): Promise<void> {
  throw new Error("Synthra: writeSymbolIndex not yet implemented (M1)");
}

export async function readSymbolIndex(_path: string): Promise<SymbolIndex> {
  throw new Error("Synthra: readSymbolIndex not yet implemented (M1)");
}
