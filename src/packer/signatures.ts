// Extracts function/class signatures from a FileNode (no bodies).
// Signatures are the first line of each symbol in the file, sorted by line.

import type { FileNode, SymbolNode } from "../graph/types.js";

export function extractSignatures(file: FileNode, symbols: SymbolNode[]): string[] {
  const mine = symbols
    .filter((s) => s.file === file.path)
    .slice()
    .sort((a, b) => a.start_line - b.start_line);

  return mine.map((s) => `L${s.start_line}: ${s.signature.trim()}`);
}
