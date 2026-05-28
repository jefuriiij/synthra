// Dispatches a file to its language-specific parser based on extension.
// Tree-sitter WASM grammars are loaded lazily via tree-sitter-wasms and
// cached per language for the lifetime of the process.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

import type { SymbolKind } from "../graph/types.js";
import { parsePython } from "./parsers/python.js";
import { parseSvelte } from "./parsers/svelte.js";
import { parseTypeScript } from "./parsers/typescript.js";
import { parseVue } from "./parsers/vue.js";
import type { WalkedFile } from "./walker.js";

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string;
}

export interface ParsedFile {
  file: WalkedFile;
  source: string;
  symbols: ParsedSymbol[];
  imports: string[];
  calls: Array<{ from: string; to: string }>;
}

const require = createRequire(import.meta.url);

export type GrammarName = "typescript" | "tsx" | "javascript" | "python";

const GRAMMAR_FILES: Record<GrammarName, string> = {
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
};

let parserInit: Promise<void> | null = null;
const languageCache = new Map<GrammarName, Parser.Language>();

async function ensureParserInit(): Promise<void> {
  if (!parserInit) {
    parserInit = Parser.init();
  }
  return parserInit;
}

export async function loadGrammar(name: GrammarName): Promise<Parser.Language> {
  await ensureParserInit();
  const cached = languageCache.get(name);
  if (cached) return cached;
  const wasmPath = require.resolve(GRAMMAR_FILES[name]);
  const lang = await Parser.Language.load(wasmPath);
  languageCache.set(name, lang);
  return lang;
}

export interface LoadedParser {
  parser: Parser;
  language: Parser.Language;
}

export async function createParser(name: GrammarName): Promise<LoadedParser> {
  const language = await loadGrammar(name);
  const parser = new Parser();
  parser.setLanguage(language);
  return { parser, language };
}

function emptyParsed(file: WalkedFile, source: string): ParsedFile {
  return { file, source, symbols: [], imports: [], calls: [] };
}

export async function parseFile(f: WalkedFile): Promise<ParsedFile> {
  let source: string;
  try {
    source = await readFile(f.absPath, "utf8");
  } catch {
    return emptyParsed(f, "");
  }

  switch (f.ext) {
    case ".ts":
    case ".tsx":
    case ".cts":
    case ".mts":
    case ".js":
    case ".jsx":
    case ".cjs":
    case ".mjs":
      return parseTypeScript(f, source);
    case ".py":
    case ".pyi":
      return parsePython(f, source);
    case ".svelte":
      return parseSvelte(f, source);
    case ".vue":
      return parseVue(f, source);
    default:
      return emptyParsed(f, source);
  }
}
