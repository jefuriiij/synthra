// HubL (HubSpot CMS templating) parser. HubL lives in .html / .hubl files and
// has no tree-sitter grammar, so we extract its symbol-like constructs with
// regex: `{% macro %}` and `{% block %}` become symbols, and
// `{% include / extends / import / from "path" %}` become import edges.
// Plain HTML with no HubL tags simply yields no symbols (same as before).

import type { ParsedFile, ParsedSymbol } from "../parser.js";
import type { WalkedFile } from "../walker.js";

// `{%-` / `-%}` are HubL/Jinja whitespace-control variants — tolerate them.
const MACRO_RE = /\{%-?\s*macro\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
const ENDMACRO_RE = /\{%-?\s*endmacro\b/g;
const BLOCK_RE = /\{%-?\s*block\s+([A-Za-z_]\w*)/g;
const ENDBLOCK_RE = /\{%-?\s*endblock\b/g;
// include / extends / import / from — all take a quoted template path first.
const IMPORT_RE = /\{%-?\s*(?:include|extends|import|from)\s+["']([^"']+)["']/g;

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

// Line of the next matching close tag after `fromIndex`; falls back to the
// start line if the template is unbalanced (no close found).
function endLineAfter(source: string, fromIndex: number, endRe: RegExp, startLine: number): number {
  endRe.lastIndex = fromIndex;
  const m = endRe.exec(source);
  return m ? lineAt(source, m.index) : startLine;
}

export function parseHubL(f: WalkedFile, source: string): ParsedFile {
  const symbols: ParsedSymbol[] = [];
  const imports: string[] = [];

  for (const m of source.matchAll(MACRO_RE)) {
    const name = m[1];
    if (!name) continue;
    const args = (m[2] ?? "").trim();
    const start = m.index ?? 0;
    const startLine = lineAt(source, start);
    symbols.push({
      name,
      kind: "function",
      startLine,
      endLine: endLineAfter(source, start + m[0].length, ENDMACRO_RE, startLine),
      signature: `macro ${name}(${args})`,
    });
  }

  for (const m of source.matchAll(BLOCK_RE)) {
    const name = m[1];
    if (!name) continue;
    const start = m.index ?? 0;
    const startLine = lineAt(source, start);
    symbols.push({
      name,
      kind: "component",
      startLine,
      endLine: endLineAfter(source, start + m[0].length, ENDBLOCK_RE, startLine),
      signature: `block ${name}`,
    });
  }

  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec) imports.push(spec);
  }

  return { file: f, source, symbols, imports: Array.from(new Set(imports)), calls: [] };
}
