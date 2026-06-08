// C parser. Function definitions, structs, enums, typedefs, #include directives.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(function_definition declarator: (function_declarator declarator: (identifier) @function.name)) @function
(struct_specifier name: (type_identifier) @struct.name) @struct
(enum_specifier name: (type_identifier) @enum.name) @enum
(type_definition declarator: (type_identifier) @type.name) @type
(preproc_include path: (string_literal) @import)
(preproc_include path: (system_lib_string) @import)
(call_expression function: (identifier) @call.name) @call
`;

export async function parseC(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "c",
      query: QUERY,
      decls: [
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
        { declCapture: "struct", nameCapture: "struct.name", kind: "class" },
        { declCapture: "enum", nameCapture: "enum.name", kind: "enum" },
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
