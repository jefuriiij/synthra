// Go parser. Functions, methods, type declarations, imports.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(function_declaration name: (identifier) @function.name) @function
(method_declaration name: (field_identifier) @method.name) @method
(type_spec name: (type_identifier) @type.name) @type
(import_spec path: (interpreted_string_literal) @import)
(call_expression function: (identifier) @call.name) @call
(call_expression function: (selector_expression field: (field_identifier) @call.name)) @call
`;

export async function parseGo(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "go",
      query: QUERY,
      decls: [
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
        { declCapture: "method", nameCapture: "method.name", kind: "method" },
        { declCapture: "type", nameCapture: "type.name", kind: "type" },
      ],
      importCapture: "import",
      callCapture: "call",
      callCalleeCapture: "call.name",
    },
    f,
    source,
  );
}
