// Dispatches a file to its language-specific parser based on extension.
// Tree-sitter WASM grammars are loaded lazily via tree-sitter-wasms and
// cached per language for the lifetime of the process.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

import type { SymbolKind } from "../graph/types.js";
import { parseC } from "./parsers/c.js";
import { parseCpp } from "./parsers/cpp.js";
import { parseCSharp } from "./parsers/csharp.js";
import { parseDart } from "./parsers/dart.js";
import { parseGo } from "./parsers/go.js";
import { parseHtml } from "./parsers/html.js";
import { parseJava } from "./parsers/java.js";
import { parseKotlin } from "./parsers/kotlin.js";
import { parsePhp } from "./parsers/php.js";
import { parsePython } from "./parsers/python.js";
import { parseRuby } from "./parsers/ruby.js";
import { parseRust } from "./parsers/rust.js";
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

/** A raw call site: the bare callee name as written (e.g. "login", not
 *  "auth.login") + its 1-based line. Caller attribution + callee resolution
 *  happen centrally in buildGraph (which has the full file set). */
export interface CallSite {
  callee: string;
  line: number;
}

export interface ParsedFile {
  file: WalkedFile;
  source: string;
  symbols: ParsedSymbol[];
  imports: string[];
  calls: CallSite[];
}

const require = createRequire(import.meta.url);

export type GrammarName =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "php"
  | "ruby"
  | "c"
  | "cpp"
  | "dart"
  | "csharp"
  | "html"
  | "css";

const GRAMMAR_FILES: Record<GrammarName, string> = {
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  go: "tree-sitter-wasms/out/tree-sitter-go.wasm",
  rust: "tree-sitter-wasms/out/tree-sitter-rust.wasm",
  java: "tree-sitter-wasms/out/tree-sitter-java.wasm",
  kotlin: "tree-sitter-wasms/out/tree-sitter-kotlin.wasm",
  php: "tree-sitter-wasms/out/tree-sitter-php.wasm",
  ruby: "tree-sitter-wasms/out/tree-sitter-ruby.wasm",
  c: "tree-sitter-wasms/out/tree-sitter-c.wasm",
  cpp: "tree-sitter-wasms/out/tree-sitter-cpp.wasm",
  dart: "tree-sitter-wasms/out/tree-sitter-dart.wasm",
  csharp: "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm",
  html: "tree-sitter-wasms/out/tree-sitter-html.wasm",
  css: "tree-sitter-wasms/out/tree-sitter-css.wasm",
};

let parserInit: Promise<void> | null = null;
const languageCache = new Map<GrammarName, Language>();

async function ensureParserInit(): Promise<void> {
  if (!parserInit) {
    parserInit = Parser.init();
  }
  return parserInit;
}

export async function loadGrammar(name: GrammarName): Promise<Language> {
  await ensureParserInit();
  const cached = languageCache.get(name);
  if (cached) return cached;
  const wasmPath = require.resolve(GRAMMAR_FILES[name]);
  const lang = await Language.load(wasmPath);
  languageCache.set(name, lang);
  return lang;
}

export interface LoadedParser {
  parser: Parser;
  language: Language;
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
  return parseSource(f, source);
}

/** Parse already-read source. Split from parseFile so the incremental scanner
 *  can read a file's content once (to hash it) and parse from that same string
 *  on a cache miss — avoiding a second read. */
export async function parseSource(f: WalkedFile, source: string): Promise<ParsedFile> {
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
    case ".html":
    case ".hubl":
      // parseHtml runs the HubL extraction itself, then adds markup, CSS and
      // inline-script symbols on top.
      return parseHtml(f, source);
    case ".go":
      return parseGo(f, source);
    case ".rs":
      return parseRust(f, source);
    case ".java":
      return parseJava(f, source);
    case ".kt":
    case ".kts":
      return parseKotlin(f, source);
    case ".php":
      return parsePhp(f, source);
    case ".rb":
      return parseRuby(f, source);
    case ".c":
    case ".h":
      return parseC(f, source);
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".hh":
    case ".hxx":
      return parseCpp(f, source);
    case ".dart":
      return parseDart(f, source);
    case ".cs":
      return parseCSharp(f, source);
    default:
      return emptyParsed(f, source);
  }
}
