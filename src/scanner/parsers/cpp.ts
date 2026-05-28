// C++ parser. Functions, classes, structs, enums, namespaces, #includes.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(function_definition declarator: (function_declarator declarator: (identifier) @function.name)) @function
(function_definition declarator: (function_declarator declarator: (qualified_identifier) @method.name)) @method
(class_specifier name: (type_identifier) @class.name) @class
(struct_specifier name: (type_identifier) @struct.name) @struct
(enum_specifier name: (type_identifier) @enum.name) @enum
(namespace_definition name: (namespace_identifier) @namespace.name) @namespace
(preproc_include path: (string_literal) @import)
(preproc_include path: (system_lib_string) @import)
`;

export async function parseCpp(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "cpp",
      query: QUERY,
      decls: [
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
        { declCapture: "method", nameCapture: "method.name", kind: "method" },
        { declCapture: "class", nameCapture: "class.name", kind: "class" },
        { declCapture: "struct", nameCapture: "struct.name", kind: "class" },
        { declCapture: "enum", nameCapture: "enum.name", kind: "enum" },
        { declCapture: "namespace", nameCapture: "namespace.name", kind: "class" },
      ],
      importCapture: "import",
    },
    f,
    source,
  );
}
