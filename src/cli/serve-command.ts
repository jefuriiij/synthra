// `syn serve [path]` — starts the HTTP MCP server against an already-scanned
// project. The graph + symbol index must exist (run `syn scan` first).
// Traps SIGINT/SIGTERM for a graceful shutdown.

import { resolve } from "node:path";
import { stat } from "node:fs/promises";

import { startServer } from "../server/http.js";
import { log } from "../shared/logger.js";
import { resolvePaths } from "../shared/paths.js";

export async function serveCommand(rawPath: string): Promise<void> {
  const projectRoot = resolve(rawPath);
  const paths = resolvePaths(projectRoot);

  try {
    await stat(paths.infoGraph);
  } catch {
    log.error(`no graph found at ${paths.infoGraph}`);
    log.error("run `syn scan` in this project first.");
    process.exit(2);
  }

  const handle = await startServer(paths);
  log.info(`MCP server listening on ${handle.url}`);
  log.info(`port written to ${paths.mcpPort}`);
  log.info("press Ctrl+C to stop.");

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info(`received ${signal} — shutting down…`);
    try {
      await handle.stop();
    } catch (err) {
      log.error("shutdown error:", (err as Error).message);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
