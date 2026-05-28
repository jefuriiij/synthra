// Graceful shutdown after `claude` exits:
//   - find latest Claude session JSONL → print `syn --resume <id>`
// MCP-server shutdown is owned by the caller (it has the ServerHandle).
// CONTEXT.md flushing is M4.

import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import { findLatestSession } from "./session-discovery.js";

export async function cleanup(paths: SynthraPaths): Promise<void> {
  const session = await findLatestSession(paths.projectRoot);
  if (!session) {
    log.info("(no Claude session transcript found — nothing to resume)");
    return;
  }
  log.info("");
  log.info(`To resume this session:  syn --resume ${session.sessionId}`);
}
