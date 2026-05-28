// Generic tree-sitter parser used by the simpler-grammar languages
// (Go, Rust, Java, Kotlin, PHP, Ruby, C, C++, Dart, C#).
//
// Each language file defines:
//   - which tree-sitter grammar to load
//   - a query string with capture names like `@function`, `@function.name`
//   - a `decls` table mapping declaration-capture pairs to SymbolKind
//   - optional `importCapture` for collecting import edges
// Everything else (parser init, error handling, dedupe) lives here.

import type Parser from "web-tree-sitter";

import type { SymbolKind } from "../../graph/types.js";
import { createParser, type GrammarName, type ParsedFile, type ParsedSymbol } from "../parser.js";
import type { WalkedFile } from "../walker.js";

type Node = Parser.SyntaxNode;

export interface DeclCapture {
  /** Capture name for the declaration node, e.g. "function". */
  declCapture: string;
  /** Capture name for the symbol's name node, e.g. "function.name". */
  nameCapture: string;
  /** SymbolKind to assign. */
  kind: SymbolKind;
}

export interface GenericParserConfig {
  grammar: GrammarName;
  query: string;
  decls: DeclCapture[];
  /** Capture name for import-source nodes. Skipped when omitted. */
  importCapture?: string;
}

export function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

function cleanImport(s: string): string {
  // Strip surrounding string-literal quotes (used by Go, Dart, C/C++).
  // Strip angle brackets used by C/C++ system includes.
  return s.replace(/^["'`<]+|["'`>]+$/g, "").trim();
}

export async function runGenericParser(
  config: GenericParserConfig,
  f: WalkedFile,
  source: string,
): Promise<ParsedFile> {
  let symbols: ParsedSymbol[] = [];
  let imports: string[] = [];

  try {
    const { parser, language } = await createParser(config.grammar);
    const tree = parser.parse(source);
    if (!tree) return { file: f, source, symbols, imports, calls: [] };

    const query = language.query(config.query);
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      const byName = new Map<string, Node>();
      for (const cap of match.captures) byName.set(cap.name, cap.node);

      let matched: DeclCapture | null = null;
      for (const d of config.decls) {
        if (byName.has(d.declCapture) && byName.has(d.nameCapture)) {
          matched = d;
          break;
        }
      }

      if (matched) {
        const declNode = byName.get(matched.declCapture)!;
        const nameNode = byName.get(matched.nameCapture)!;
        symbols.push({
          name: nameNode.text,
          kind: matched.kind,
          startLine: declNode.startPosition.row + 1,
          endLine: declNode.endPosition.row + 1,
          signature: firstLine(declNode.text),
        });
        continue;
      }

      if (config.importCapture) {
        const imp = byName.get(config.importCapture);
        if (imp) imports.push(cleanImport(imp.text));
      }
    }

    const seen = new Set<string>();
    symbols = symbols.filter((s) => {
      const k = `${s.name}:${s.startLine}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    imports = Array.from(new Set(imports)).filter((s) => s.length > 0);
  } catch {
    // Query compile or parse failure — return what we have. Silent so a single
    // bad file doesn't abort the whole scan.
  }

  return { file: f, source, symbols, imports, calls: [] };
}
