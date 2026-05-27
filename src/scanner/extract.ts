// Turns ParsedFile[] into a GraphSchema (nodes + edges).
// TODO: M1

import type { ParsedFile } from "./parser.js";
import type { GraphSchema } from "../graph/types.js";

export async function buildGraph(_root: string, _parsed: ParsedFile[]): Promise<GraphSchema> {
  throw new Error("Synthra: buildGraph not yet implemented (M1)");
}
