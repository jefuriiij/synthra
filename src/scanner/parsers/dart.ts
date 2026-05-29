// Dart parser. v0.1.11 — real symbol extraction + import parsing on top of the
// ABI-v15 grammar that ships in tree-sitter-wasms.
//
// Distinguishes top-level function_signature (kind: function) from
// function_signature nested under method_signature (kind: method) by
// anchoring the top-level pattern under `program`.
//
// Imports: `package:foo/bar.dart` and `dart:async` are stripped — they cross
// the project boundary. Bare `foo.dart` is normalized to `./foo.dart` so the
// shared resolveImport() (which requires a leading `.`) treats it as a
// same-directory relative import.

import type { Node } from "web-tree-sitter";
import type { SymbolKind } from "../../graph/types.js";
import { createParser, type ParsedFile, type ParsedSymbol } from "../parser.js";
import type { WalkedFile } from "../walker.js";

const QUERY = `
(class_definition name: (identifier) @class.name) @class
(mixin_declaration (identifier) @mixin.name) @mixin
(extension_declaration name: (identifier) @ext.name) @ext
(enum_declaration name: (identifier) @enum.name) @enum
(type_alias (type_identifier) @typedef.name) @typedef

(program (function_signature name: (identifier) @function.name) @function)

(method_signature (function_signature name: (identifier) @method.name)) @method
(method_signature (getter_signature name: (identifier) @getter.name)) @getter
(method_signature (setter_signature name: (identifier) @setter.name)) @setter
(constructor_signature name: (identifier) @ctor.name) @ctor

(import_or_export (library_import (import_specification (configurable_uri (uri (string_literal) @import)))))
`;

interface DeclShape {
  declCap: string;
  nameCap: string;
  kind: SymbolKind;
}

const DECLS: DeclShape[] = [
  { declCap: "class", nameCap: "class.name", kind: "class" },
  { declCap: "mixin", nameCap: "mixin.name", kind: "class" },
  { declCap: "ext", nameCap: "ext.name", kind: "class" },
  { declCap: "enum", nameCap: "enum.name", kind: "enum" },
  { declCap: "typedef", nameCap: "typedef.name", kind: "type" },
  { declCap: "function", nameCap: "function.name", kind: "function" },
  { declCap: "method", nameCap: "method.name", kind: "method" },
  { declCap: "getter", nameCap: "getter.name", kind: "method" },
  { declCap: "setter", nameCap: "setter.name", kind: "method" },
  { declCap: "ctor", nameCap: "ctor.name", kind: "method" },
];

function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

// Strip surrounding string-literal quotes and normalize bare same-directory
// imports (Dart allows `import 'foo.dart';` without a leading `./`) so
// resolveImport() — which keys off a leading dot — can match them.
function normalizeDartImport(raw: string): string | null {
  const stripped = raw.replace(/^['"]|['"]$/g, "");
  if (!stripped) return null;
  if (stripped.startsWith("package:")) return null;
  if (stripped.startsWith("dart:")) return null;
  if (stripped.startsWith(".") || stripped.startsWith("/")) return stripped;
  return `./${stripped}`;
}

export async function parseDart(f: WalkedFile, source: string): Promise<ParsedFile> {
  let symbols: ParsedSymbol[] = [];
  let imports: string[] = [];

  try {
    const { parser, language } = await createParser("dart");
    const tree = parser.parse(source);
    if (!tree) return { file: f, source, symbols, imports, calls: [] };

    const query = language.query(QUERY);
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      const byName = new Map<string, Node>();
      for (const cap of match.captures) byName.set(cap.name, cap.node);

      let matched: DeclShape | null = null;
      for (const d of DECLS) {
        if (byName.has(d.declCap) && byName.has(d.nameCap)) {
          matched = d;
          break;
        }
      }

      if (matched) {
        const declNode = byName.get(matched.declCap)!;
        const nameNode = byName.get(matched.nameCap)!;
        symbols.push({
          name: nameNode.text,
          kind: matched.kind,
          startLine: declNode.startPosition.row + 1,
          endLine: declNode.endPosition.row + 1,
          signature: firstLine(declNode.text),
        });
        continue;
      }

      const importNode = byName.get("import");
      if (importNode) {
        const norm = normalizeDartImport(importNode.text);
        if (norm) imports.push(norm);
      }
    }

    const seen = new Set<string>();
    symbols = symbols.filter((s) => {
      const k = `${s.name}:${s.startLine}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    imports = Array.from(new Set(imports));
  } catch {
    // swallow — see _generic.ts for the rationale (single bad file shouldn't
    // abort the whole scan).
  }

  return { file: f, source, symbols, imports, calls: [] };
}
