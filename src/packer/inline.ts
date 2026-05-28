// Picks the top function bodies from a file (by relevance to the query) and
// inlines them, respecting a char-based budget. Truncates oversized bodies.

import { tokenizeQuery } from "../graph/rank.js";
import type { FileNode, SymbolKind, SymbolNode } from "../graph/types.js";

export interface InlineSelection {
  text: string;
  charsUsed: number;
  functionsInlined: string[];
}

const INLINABLE_KINDS = new Set<SymbolKind>(["function", "method", "class"]);
const MAX_BODY_CHARS = 1500;

function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
}

function scoreSymbol(name: string, qTokens: Set<string>): number {
  const lower = name.toLowerCase();
  if (qTokens.has(lower)) return 3;
  for (const t of qTokens) {
    if (lower.includes(t) || t.includes(lower)) return 1;
  }
  return 0;
}

function truncate(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return body.slice(0, MAX_BODY_CHARS).trimEnd() + "\n  // … truncated";
}

export function selectInlineBodies(
  file: FileNode,
  symbols: SymbolNode[],
  query: string,
  budgetChars: number,
): InlineSelection {
  if (budgetChars <= 0) {
    return { text: "", charsUsed: 0, functionsInlined: [] };
  }

  const qTokens = new Set(tokenizeQuery(query));
  const mine = symbols.filter((s) => s.file === file.path && INLINABLE_KINDS.has(s.symbol_kind));

  const scored = mine
    .map((s) => ({ sym: s, score: scoreSymbol(s.name, qTokens) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break: smaller bodies first (so we fit more)
      const aSpan = (a.sym.end_line - a.sym.start_line) || 1;
      const bSpan = (b.sym.end_line - b.sym.start_line) || 1;
      return aSpan - bSpan;
    });

  const parts: string[] = [];
  const inlined: string[] = [];
  let used = 0;

  for (const { sym, score } of scored) {
    // Skip irrelevant symbols entirely when we have positive hits available;
    // fall back to top-by-size if no query match landed.
    if (score === 0 && inlined.length > 0) break;

    const body = truncate(sliceLines(file.content, sym.start_line, sym.end_line));
    const header = `${file.path}::${sym.name} (L${sym.start_line}-${sym.end_line})`;
    const block = `${header}\n${body}\n`;
    if (used + block.length > budgetChars) {
      if (inlined.length > 0) break;
      // No room and nothing yet — take a head-only slice.
      const remaining = Math.max(0, budgetChars - used - header.length - 16);
      if (remaining <= 0) break;
      const partial = body.slice(0, remaining).trimEnd() + "\n  // … truncated";
      const finalBlock = `${header}\n${partial}\n`;
      parts.push(finalBlock);
      inlined.push(sym.name);
      used += finalBlock.length;
      break;
    }
    parts.push(block);
    inlined.push(sym.name);
    used += block.length;
  }

  return { text: parts.join("\n"), charsUsed: used, functionsInlined: inlined };
}
