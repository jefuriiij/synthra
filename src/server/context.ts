// Shared context passed to every route handler. Holds the loaded graph,
// symbol index, and the project's resolved paths.

import type { GraphSchema, SymbolIndex } from "../graph/types.js";
import type { SynthraPaths } from "../shared/paths.js";

export interface ServerContext {
  paths: SynthraPaths;
  graph: GraphSchema;
  symbolIndex: SymbolIndex;
}
