// `syn` entry point. Parses args and dispatches to commands.
//
// Commands:
//   syn  [path]              → default: bootstrap + scan + serve + launch Claude
//   syn . [path]             → alias for default
//   syn scan [path]          → scan only — walk + parse + write graph
//   syn serve [path]         → start the HTTP MCP server only
//   syn --resume <id> [path] → default flow, but resume an existing session

import sade from "sade";

import { startServer } from "../server/http.js";
import { log } from "../shared/logger.js";
import { resolvePaths } from "../shared/paths.js";
import { cleanup } from "./cleanup.js";
import { dashboardCommand } from "./dashboard-command.js";
import { scanCommand } from "./scan-command.js";
import { serveCommand } from "./serve-command.js";
import { startClaude } from "./start-claude.js";

import { resolve } from "node:path";

const VERSION = "0.0.1";

interface DefaultOpts {
  resume?: string;
}

async function defaultFlow(rawPath: string, opts: DefaultOpts): Promise<void> {
  const projectRoot = resolve(rawPath);
  const paths = resolvePaths(projectRoot);

  // 1. bootstrap + scan
  await scanCommand(rawPath);

  // 2. start MCP server (background within this process)
  const handle = await startServer(paths);
  log.info(`MCP server listening on ${handle.url}`);

  try {
    // 3. install hooks + register MCP + spawn claude (waits for exit)
    const code = await startClaude({
      paths,
      mcpPort: handle.port,
      resumeSessionId: opts.resume,
    });
    log.info(`claude exited with code ${code}`);
  } finally {
    // 4. always tear down
    try {
      await handle.stop();
      log.info("MCP server stopped.");
    } catch (err) {
      log.warn(`server stop error: ${(err as Error).message}`);
    }
    try {
      await cleanup(paths);
    } catch (err) {
      log.warn(`cleanup error: ${(err as Error).message}`);
    }
  }
}

export function buildProgram() {
  const prog = sade("syn");
  prog
    .version(VERSION)
    .describe("Local context engine for AI coding assistants.");

  prog
    .command(". [path]", "Bootstrap + scan + launch Claude with Synthra MCP.", {
      default: true,
    })
    .option("--resume <id>", "Resume a Claude session by id")
    .action(async (path: string | undefined, opts: DefaultOpts) => {
      await defaultFlow(path ?? ".", opts);
    });

  prog
    .command("scan [path]", "Scan only — walk + parse + write graph.")
    .action(async (path: string | undefined) => {
      await scanCommand(path ?? ".");
    });

  prog
    .command("serve [path]", "Start the HTTP MCP server against a scanned project.")
    .action(async (path: string | undefined) => {
      await serveCommand(path ?? ".");
    });

  prog
    .command("dashboard [path]", "Run the token dashboard server (localhost:8901).")
    .action(async (path: string | undefined) => {
      await dashboardCommand(path ?? ".");
    });

  return prog;
}

export async function main(argv: string[]): Promise<void> {
  const prog = buildProgram();
  prog.parse(argv);
}

// Note: `main` is invoked by bin/syn, NOT here. Top-level invocation on
// import would side-effect any consumer that just wants to read exports.
