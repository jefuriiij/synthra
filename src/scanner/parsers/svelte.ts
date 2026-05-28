// Svelte parser. Extracts <script> and <script lang="ts"> blocks and parses
// their contents with the TypeScript parser. Tracks the original line offset
// so reported symbol positions match the .svelte source.

import { parseTypeScript } from "./typescript.js";
import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

interface ScriptBlock {
  source: string;
  startLine: number; // 1-based line number where the script content begins
  isTsx: boolean;
}

function extractScripts(source: string): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  for (const match of source.matchAll(SCRIPT_RE)) {
    const full = match[0];
    const inner = match[1] ?? "";
    const openTag = full.slice(0, full.indexOf(">") + 1);
    const tagStart = match.index ?? 0;
    const contentStart = tagStart + openTag.length;
    const startLine = source.slice(0, contentStart).split(/\r?\n/).length;
    const isTsx = /\blang\s*=\s*["']?(ts|tsx|typescript)["']?/i.test(openTag);
    out.push({ source: inner, startLine, isTsx });
  }
  return out;
}

export async function parseSvelte(f: WalkedFile, source: string): Promise<ParsedFile> {
  const blocks = extractScripts(source);
  const out: ParsedFile = { file: f, source, symbols: [], imports: [], calls: [] };

  for (const block of blocks) {
    const virtual: WalkedFile = { ...f, ext: block.isTsx ? ".ts" : ".js" };
    const parsed = await parseTypeScript(virtual, block.source);
    const offset = block.startLine - 1;
    for (const sym of parsed.symbols) {
      out.symbols.push({
        ...sym,
        startLine: sym.startLine + offset,
        endLine: sym.endLine + offset,
      });
    }
    for (const imp of parsed.imports) out.imports.push(imp);
  }

  // The .svelte file itself is treated as a component.
  out.symbols.push({
    name: f.relPath.split("/").pop()?.replace(/\.svelte$/i, "") ?? f.relPath,
    kind: "component",
    startLine: 1,
    endLine: source.split(/\r?\n/).length,
    signature: f.relPath,
  });
  out.imports = Array.from(new Set(out.imports));
  return out;
}
