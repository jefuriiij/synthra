// Shared context passed to every route handler. Holds the loaded graph,
// symbol index, the project's resolved paths, and the live activity store.

import type { ActivityStore } from "../activity/activity-log.js";
import type { GraphSchema, SymbolIndex } from "../graph/types.js";
import type { LearnRuntime } from "../learn/runtime.js";
import type { SynthraPaths } from "../shared/paths.js";

export interface ServerContext {
  paths: SynthraPaths;
  graph: GraphSchema;
  symbolIndex: SymbolIndex;
  activity: ActivityStore;
  /** Usage-learning runtime. Optional so test/CLI contexts can omit it; when
   *  absent, retrieval simply gets no usage boost (degrades to deterministic). */
  learn?: LearnRuntime;
}
