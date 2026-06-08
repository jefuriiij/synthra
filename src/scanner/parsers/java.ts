// Java parser. Classes, interfaces, methods, imports.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(class_declaration name: (identifier) @class.name) @class
(interface_declaration name: (identifier) @interface.name) @interface
(method_declaration name: (identifier) @method.name) @method
(enum_declaration name: (identifier) @enum.name) @enum
(import_declaration (scoped_identifier) @import)
(method_invocation name: (identifier) @call.name) @call
`;

export async function parseJava(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "java",
      query: QUERY,
      decls: [
        { declCapture: "class", nameCapture: "class.name", kind: "class" },
        { declCapture: "interface", nameCapture: "interface.name", kind: "interface" },
        { declCapture: "method", nameCapture: "method.name", kind: "method" },
        { declCapture: "enum", nameCapture: "enum.name", kind: "enum" },
      ],
      importCapture: "import",
      callCapture: "call",
      callCalleeCapture: "call.name",
    },
    f,
    source,
  );
}
