// Dart parser. Classes, functions, methods, imports.
//
// KNOWN v0.1 LIMITATION: tree-sitter-dart's node field names vary across
// grammar versions, and the version shipped in tree-sitter-wasms doesn't
// match what our generic helper expects. Symbol extraction is unreliable
// today; .dart files are still walked + content-indexed so keyword search
// and graph_continue still work — just no symbol-level granularity. Fix in
// v0.2 by reading the grammar's exact node schema and adjusting the query.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

// tree-sitter-dart node fields vary across grammar versions. Match loosely
// by anonymous children — works on most published grammars.
const QUERY = `
(class_definition (identifier) @class.name) @class
(mixin_declaration (identifier) @class.name) @mixin
(extension_declaration (identifier) @class.name) @ext
(function_signature (identifier) @function.name) @function
`;

export async function parseDart(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "dart",
      query: QUERY,
      decls: [
        { declCapture: "class", nameCapture: "class.name", kind: "class" },
        { declCapture: "mixin", nameCapture: "class.name", kind: "class" },
        { declCapture: "ext", nameCapture: "class.name", kind: "class" },
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
      ],
    },
    f,
    source,
  );
}
