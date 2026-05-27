// Graceful shutdown after `claude` exits:
//   - stop MCP server + activity watcher
//   - flush session.json
//   - find latest Claude session JSONL → print `syn --resume <id>`
// TODO: M3

import type { SynthraPaths } from "../shared/paths.js";

export async function cleanup(_paths: SynthraPaths): Promise<void> {
  throw new Error("Synthra: cleanup not yet implemented (M3)");
}
