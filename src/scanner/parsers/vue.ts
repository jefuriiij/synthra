// Vue SFC parser. Extracts <script> / <script setup> / <script lang="ts">
// blocks and parses them with the TypeScript parser, preserving line offsets.

import { parseTypeScript } from "./typescript.js";
import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

interface ScriptBlock {
  source: string;
  startLine: number;
  isTs: boolean;
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
    const isTs = /\blang\s*=\s*["']?(ts|tsx|typescript)["']?/i.test(openTag);
    out.push({ source: inner, startLine, isTs });
  }
  return out;
}

export async function parseVue(f: WalkedFile, source: string): Promise<ParsedFile> {
  const blocks = extractScripts(source);
  const out: ParsedFile = { file: f, source, symbols: [], imports: [], calls: [] };

  for (const block of blocks) {
    const virtual: WalkedFile = { ...f, ext: block.isTs ? ".ts" : ".js" };
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

  out.symbols.push({
    name: f.relPath.split("/").pop()?.replace(/\.vue$/i, "") ?? f.relPath,
    kind: "component",
    startLine: 1,
    endLine: source.split(/\r?\n/).length,
    signature: f.relPath,
  });
  out.imports = Array.from(new Set(out.imports));
  return out;
}
