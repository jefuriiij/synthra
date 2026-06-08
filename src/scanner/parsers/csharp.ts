// C# (.NET) parser. Classes, interfaces, structs, methods, namespaces.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(class_declaration name: (identifier) @class.name) @class
(interface_declaration name: (identifier) @interface.name) @interface
(struct_declaration name: (identifier) @struct.name) @struct
(enum_declaration name: (identifier) @enum.name) @enum
(method_declaration name: (identifier) @method.name) @method
(namespace_declaration name: (_) @namespace.name) @namespace
(using_directive (_) @import)
(invocation_expression function: (identifier) @call.name) @call
(invocation_expression function: (member_access_expression name: (identifier) @call.name)) @call
`;

export async function parseCSharp(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "csharp",
      query: QUERY,
      decls: [
        { declCapture: "class", nameCapture: "class.name", kind: "class" },
        { declCapture: "interface", nameCapture: "interface.name", kind: "interface" },
        { declCapture: "struct", nameCapture: "struct.name", kind: "class" },
        { declCapture: "enum", nameCapture: "enum.name", kind: "enum" },
        { declCapture: "method", nameCapture: "method.name", kind: "method" },
        { declCapture: "namespace", nameCapture: "namespace.name", kind: "class" },
      ],
      importCapture: "import",
      callCapture: "call",
      callCalleeCapture: "call.name",
    },
    f,
    source,
  );
}
