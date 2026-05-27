// TS/JS parser using tree-sitter-typescript (WASM).
// TODO: M1

import type { WalkedFile } from "../walker.js";
import type { ParsedFile } from "../parser.js";

export async function parseTypeScript(_f: WalkedFile, _source: string): Promise<ParsedFile> {
  throw new Error("Synthra: parseTypeScript not yet implemented (M1)");
}
