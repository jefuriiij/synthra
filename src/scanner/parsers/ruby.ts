// Ruby parser. Methods, classes, modules.
// Imports omitted — Ruby's `require` is dynamic and hard to capture cleanly;
// keyword indexing still surfaces dependencies.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(method name: (identifier) @function.name) @function
(singleton_method name: (identifier) @method.name) @method
(class name: (constant) @class.name) @class
(module name: (constant) @module.name) @module
`;

export async function parseRuby(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "ruby",
      query: QUERY,
      decls: [
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
        { declCapture: "method", nameCapture: "method.name", kind: "method" },
        { declCapture: "class", nameCapture: "class.name", kind: "class" },
        { declCapture: "module", nameCapture: "module.name", kind: "class" },
      ],
    },
    f,
    source,
  );
}
