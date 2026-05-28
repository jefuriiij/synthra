// Rust parser. Functions, structs, enums, traits, impls.
// Import capture is omitted — `use` paths are nested and complex; the file
// will still be walked + keyword-indexed.

import type { ParsedFile } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { runGenericParser } from "./_generic.js";

const QUERY = `
(function_item name: (identifier) @function.name) @function
(struct_item name: (type_identifier) @struct.name) @struct
(enum_item name: (type_identifier) @enum.name) @enum
(trait_item name: (type_identifier) @trait.name) @trait
(impl_item type: (type_identifier) @impl.name) @impl
`;

export async function parseRust(f: WalkedFile, source: string): Promise<ParsedFile> {
  return runGenericParser(
    {
      grammar: "rust",
      query: QUERY,
      decls: [
        { declCapture: "function", nameCapture: "function.name", kind: "function" },
        { declCapture: "struct", nameCapture: "struct.name", kind: "class" },
        { declCapture: "enum", nameCapture: "enum.name", kind: "enum" },
        { declCapture: "trait", nameCapture: "trait.name", kind: "interface" },
        { declCapture: "impl", nameCapture: "impl.name", kind: "class" },
      ],
    },
    f,
    source,
  );
}
