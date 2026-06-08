// Kotlin parser. Functions, classes, objects, interfaces, imports.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(function_declaration (simple_identifier) @function.name) @function
(class_declaration (type_identifier) @class.name) @class
(object_declaration (type_identifier) @object.name) @object
(import_header (identifier) @import)
(call_expression (simple_identifier) @call.name) @call
`;

export async function parseKotlin(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "kotlin",
      query: QUERY,
      decls: [
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
        { declCapture: "class", nameCapture: "class.name", kind: "class" },
        { declCapture: "object", nameCapture: "object.name", kind: "class" },
      ],
      importCapture: "import",
      callCapture: "call",
      callCalleeCapture: "call.name",
    },
    f,
    source,
  );
}
