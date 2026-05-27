// Dispatches a file to its language-specific parser based on extension.
// Tree-sitter WASM is loaded lazily per language.
// TODO: M1

import type { WalkedFile } from "./walker.js";

export interface ParsedFile {
  file: WalkedFile;
  symbols: Array<{
    name: string;
    kind: import("../graph/types.js").SymbolKind;
    startLine: number;
    endLine: number;
    signature: string;
  }>;
  imports: string[];
  calls: Array<{ from: string; to: string }>;
}

export async function parseFile(_f: WalkedFile): Promise<ParsedFile> {
  throw new Error("Synthra: parseFile not yet implemented (M1)");
}
