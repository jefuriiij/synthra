// Python parser using tree-sitter-python (WASM).
// TODO: M1

import type { WalkedFile } from "../walker.js";
import type { ParsedFile } from "../parser.js";

export async function parsePython(_f: WalkedFile, _source: string): Promise<ParsedFile> {
  throw new Error("Synthra: parsePython not yet implemented (M1)");
}
