// `syn dashboard [path]` — starts the standalone token dashboard server on
// localhost:8901 (or SYN_DASHBOARD_PORT). Reads token_log.jsonl + gate_log.jsonl
// for the given project. Runs until Ctrl+C.

import { resolve } from "node:path";

import { startDashboard } from "../dashboard/server.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { resolvePaths } from "../shared/paths.js";

export async function dashboardCommand(rawPath: string): Promise<void> {
  const projectRoot = resolve(rawPath);
  const paths = resolvePaths(projectRoot);
  const cfg = loadConfig();

  const handle = await startDashboard(paths, cfg.dashboardPort);
  log.info(`Synthra dashboard listening on ${handle.url}`);
  log.info(`project: ${projectRoot}`);
  log.info(`reading: ${paths.tokenLog}`);
  log.info(`         ${paths.gateLog}`);
  log.info("press Ctrl+C to stop.");

  await new Promise<void>((res) => {
    const shutdown = async (signal: NodeJS.Signals) => {
      log.info(`received ${signal} — shutting down…`);
      try {
        await handle.stop();
      } catch (err) {
        log.warn(`dashboard stop error: ${(err as Error).message}`);
      }
      res();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

// Backwards-compat alias matching the M2-era stub signature.
export async function openDashboard(_port = 8901): Promise<void> {
  return dashboardCommand(".");
}
