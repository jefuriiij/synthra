// PHP parser. Functions, classes, interfaces, methods, traits.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(function_definition name: (name) @function.name) @function
(class_declaration name: (name) @class.name) @class
(interface_declaration name: (name) @interface.name) @interface
(trait_declaration name: (name) @trait.name) @trait
(method_declaration name: (name) @method.name) @method
(function_call_expression function: (name) @call.name) @call
(member_call_expression name: (name) @call.name) @call
(scoped_call_expression name: (name) @call.name) @call
`;

export async function parsePhp(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "php",
      query: QUERY,
      decls: [
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
        { declCapture: "class", nameCapture: "class.name", kind: "class" },
        { declCapture: "interface", nameCapture: "interface.name", kind: "interface" },
        { declCapture: "trait", nameCapture: "trait.name", kind: "class" },
        { declCapture: "method", nameCapture: "method.name", kind: "method" },
      ],
      callCapture: "call",
      callCalleeCapture: "call.name",
    },
    f,
    source,
  );
}
