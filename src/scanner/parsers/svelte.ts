// Svelte parser. Splits a .svelte file into <script>/<style>/<template>
// and parses the script with the TS parser. Component props extracted.
// TODO: M1

import type { WalkedFile } from "../walker.js";
import type { ParsedFile } from "../parser.js";

export async function parseSvelte(_f: WalkedFile, _source: string): Promise<ParsedFile> {
  throw new Error("Synthra: parseSvelte not yet implemented (M1)");
}
