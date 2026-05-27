// Vue SFC parser. Extracts <script>/<script setup> and parses with TS parser.
// TODO: M1

import type { WalkedFile } from "../walker.js";
import type { ParsedFile } from "../parser.js";

export async function parseVue(_f: WalkedFile, _source: string): Promise<ParsedFile> {
  throw new Error("Synthra: parseVue not yet implemented (M1)");
}
