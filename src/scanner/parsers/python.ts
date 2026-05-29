// Python parser using tree-sitter-python WASM.
// Extracts: function/class definitions, methods, and import statements.

import type { Node } from "web-tree-sitter";
import { createParser, type ParsedFile, type ParsedSymbol } from "../parser.js";
import type { WalkedFile } from "../walker.js";

const QUERY = `
(function_definition name: (identifier) @function.name) @function
(class_definition name: (identifier) @class.name) @class
(import_statement name: (dotted_name) @import.module)
(import_from_statement module_name: (dotted_name) @import.from)
(import_from_statement module_name: (relative_import) @import.from)
`;

function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

export async function parsePython(f: WalkedFile, source: string): Promise<ParsedFile> {
  let symbols: ParsedSymbol[] = [];
  let imports: string[] = [];

  try {
    const { parser, language } = await createParser("python");
    const tree = parser.parse(source);
    if (!tree) return { file: f, source, symbols, imports, calls: [] };

    const query = language.query(QUERY);
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      const byName = new Map<string, Node>();
      for (const cap of match.captures) byName.set(cap.name, cap.node);

      const funcDecl = byName.get("function");
      const funcName = byName.get("function.name");
      if (funcDecl && funcName) {
        const parentType = funcDecl.parent?.parent?.type;
        const isMethod = parentType === "class_definition";
        symbols.push({
          name: funcName.text,
          kind: isMethod ? "method" : "function",
          startLine: funcDecl.startPosition.row + 1,
          endLine: funcDecl.endPosition.row + 1,
          signature: firstLine(funcDecl.text),
        });
        continue;
      }

      const classDecl = byName.get("class");
      const className = byName.get("class.name");
      if (classDecl && className) {
        symbols.push({
          name: className.text,
          kind: "class",
          startLine: classDecl.startPosition.row + 1,
          endLine: classDecl.endPosition.row + 1,
          signature: firstLine(classDecl.text),
        });
        continue;
      }

      const importNode = byName.get("import.module") ?? byName.get("import.from");
      if (importNode) imports.push(importNode.text);
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
    // swallow parse errors
  }

  return { file: f, source, symbols, imports, calls: [] };
}
