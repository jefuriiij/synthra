// TS/JS parser using tree-sitter-typescript / -tsx WASM grammars.
// Extracts: function/class/interface/type/enum declarations, exported consts,
// arrow functions assigned to const, and import sources.

import type { Node } from "web-tree-sitter";
import type { SymbolKind } from "../../graph/types.js";
import { createParser, type GrammarName, type ParsedFile, type ParsedSymbol } from "../parser.js";
import type { WalkedFile } from "../walker.js";

// TS / TSX query — uses the type-identifier node type for class names, includes
// interface / type-alias / enum declarations that don't exist in plain JS.
const TS_QUERY = `
(function_declaration name: (identifier) @function.name) @function
(class_declaration name: (type_identifier) @class.name) @class
(interface_declaration name: (type_identifier) @interface.name) @interface
(type_alias_declaration name: (type_identifier) @type.name) @type
(enum_declaration name: (identifier) @enum.name) @enum
(method_definition name: (property_identifier) @method.name) @method
(lexical_declaration (variable_declarator name: (identifier) @const-fn.name value: [(arrow_function) (function_expression)])) @const-fn
(import_statement source: (string) @import)
`;

// JS query — class names are plain identifiers (JS grammar has no
// type_identifier node). No interface / type_alias / enum since JS lacks them.
// Adds a call_expression capture for CommonJS require('x'); filtered in the
// matching loop by checking the function identifier text equals "require".
const JS_QUERY = `
(function_declaration name: (identifier) @function.name) @function
(class_declaration name: (identifier) @class.name) @class
(method_definition name: (property_identifier) @method.name) @method
(lexical_declaration (variable_declarator name: (identifier) @const-fn.name value: [(arrow_function) (function_expression)])) @const-fn
(import_statement source: (string) @import)
(call_expression function: (identifier) @_require_fn arguments: (arguments . (string) @require_source))
`;

function grammarFor(ext: string): GrammarName {
  if (ext === ".tsx" || ext === ".jsx") return "tsx";
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") return "javascript";
  return "typescript";
}

function queryFor(grammar: GrammarName): string {
  return grammar === "javascript" ? JS_QUERY : TS_QUERY;
}

function unquote(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}

function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

interface DeclShape {
  decl: Node;
  name: Node;
  kind: SymbolKind;
}

function shapeFromCaptures(captures: Map<string, Node>): DeclShape | null {
  const findDecl = (k: string, sk: SymbolKind): DeclShape | null => {
    const decl = captures.get(k);
    const name = captures.get(`${k}.name`);
    return decl && name ? { decl, name, kind: sk } : null;
  };

  return (
    findDecl("function", "function") ??
    findDecl("class", "class") ??
    findDecl("interface", "interface") ??
    findDecl("type", "type") ??
    findDecl("enum", "enum") ??
    findDecl("method", "method") ??
    findDecl("const-fn", "function")
  );
}

export async function parseTypeScript(f: WalkedFile, source: string): Promise<ParsedFile> {
  const grammar = grammarFor(f.ext);
  let symbols: ParsedSymbol[] = [];
  let imports: string[] = [];

  try {
    const { parser, language } = await createParser(grammar);
    const tree = parser.parse(source);
    if (!tree) return { file: f, source, symbols, imports, calls: [] };

    const query = language.query(queryFor(grammar));
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      const byName = new Map<string, Node>();
      for (const cap of match.captures) byName.set(cap.name, cap.node);

      const shape = shapeFromCaptures(byName);
      if (shape) {
        symbols.push({
          name: shape.name.text,
          kind: shape.kind,
          startLine: shape.decl.startPosition.row + 1,
          endLine: shape.decl.endPosition.row + 1,
          signature: firstLine(shape.decl.text),
        });
        continue;
      }
      const importNode = byName.get("import");
      if (importNode) {
        imports.push(unquote(importNode.text));
        continue;
      }
      // CommonJS require('x') — only captured by JS_QUERY. The identifier
      // must literally be "require" (not setTimeout, console, etc).
      const requireFn = byName.get("_require_fn");
      const requireSource = byName.get("require_source");
      if (requireFn && requireSource && requireFn.text === "require") {
        imports.push(unquote(requireSource.text));
      }
    }

    const seen = new Set<string>();
    symbols = symbols.filter((s) => {
      const key = `${s.name}:${s.startLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    imports = Array.from(new Set(imports));
  } catch {
    // Parse failure shouldn't abort the whole scan — return what we have.
  }

  return { file: f, source, symbols, imports, calls: [] };
}
