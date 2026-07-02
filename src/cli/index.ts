// `syn` entry point. Parses args and dispatches to commands.
//
// Commands:
//   syn  [path]              → default: scan + start MCP + dashboard +
//                              register MCP for IDE extension; block on
//                              Ctrl+C. NO claude CLI spawn — use the IDE.
//   syn . [path]             → alias for default
//   syn . --launch-cli       → also spawn `claude` here (M3 behavior)
//   syn scan [path]          → scan only
//   syn serve [path]         → start MCP server only
//   syn dashboard [path]     → run only the dashboard server
//   syn --resume <id> [path] → resume an existing Claude session
//                              (only meaningful with --launch-cli)

import sade from "sade";
import { resolve } from "node:path";

// Inlined at build time by tsup's JSON loader so `syn --version` always
// matches the published package.
import pkgJson from "../../package.json" with { type: "json" };

import { startDashboard, type DashboardServerHandle } from "../dashboard/server.js";
import { installHooks } from "../hooks/installer.js";
import { startServer, type ServerHandle } from "../server/http.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { resolvePaths } from "../shared/paths.js";
import { recordProject } from "../shared/project-registry.js";
import { cleanup } from "./cleanup.js";
import { dashboardCommand } from "./dashboard-command.js";
import { doctorCommand } from "./doctor-command.js";
import { removeCommand } from "./remove-command.js";
import { scanCommand, type ScanResult } from "./scan-command.js";
import { promptForUpdateOrLog, runStartupChangelogCheck } from "./self-update.js";
import { serveCommand } from "./serve-command.js";
import { registerMcp, spawnClaude, unregisterMcp } from "./start-claude.js";

const VERSION = (pkgJson as { version: string }).version;

interface DefaultOpts {
  resume?: string;
  "launch-cli"?: boolean;
  full?: boolean;
}

interface BannerInfo {
  projectRoot: string;
  scan: ScanResult;
  mcpUrl: string;
  dashboardUrl: string | null;
  mcpRegistered: boolean;
}

function printReadyBanner(info: BannerInfo): void {
  log.info("");
  log.info(
    `  ✅  scanned   ${info.scan.parsed} files · ${info.scan.symbolCount} symbols · ${info.scan.edgeCount} edges`,
  );
  if (info.mcpRegistered) {
    log.info(`  🧠  MCP       ${info.mcpUrl}   →  registered as 'synthra'`);
  } else {
    log.info(`  🧠  MCP       ${info.mcpUrl}   ⚠  registration with claude failed`);
  }
  if (info.dashboardUrl) {
    log.info(`  📊  Dashboard ${info.dashboardUrl}`);
  } else {
    log.info(`  📊  Dashboard (failed to start; data is still logged to .synthra-graph/)`);
  }
  log.info(`  🪝  Hooks     installed in .claude/settings.local.json`);
  log.info("");
  log.info(
    `  🤖  Ready — open the Claude Code IDE extension (or run \`claude\` in another terminal).`,
  );
  log.info(`      Synthra's tools and gate will be active for that session.`);
  log.info("");
  log.info(`  Press Ctrl+C here when you're done.`);
  log.info("");
}

function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const handler = (sig: NodeJS.Signals) => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      resolve(sig);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
}

async function defaultFlow(rawPath: string, opts: DefaultOpts): Promise<void> {
  const launchCli = opts["launch-cli"] === true;
  const projectRoot = resolve(rawPath);
  const paths = resolvePaths(projectRoot);
  const cfg = loadConfig();

  // If the running binary is newer than last-seen (e.g. user upgraded via
  // `npm install -g …@latest` directly), print the changelog for what they
  // just got. Silent if already on latest-seen or on fresh install.
  await runStartupChangelogCheck();

  // Always-fresh registry check (no cache). If a newer version is on npm AND
  // we're on a TTY, prompts [y/N]. On 'y', runs npm install, prints the new
  // version's changelog, and exits with re-run instructions. On 'n' / no
  // update / non-TTY, continues silently. SYN_NO_UPDATE_CHECK=1 opts out.
  await promptForUpdateOrLog();

  // 1. bootstrap + scan + record in the global registry so the dashboard
  //    can list this project alongside any others.
  await recordProject(projectRoot);
  const scan = await scanCommand(rawPath, { full: opts.full });

  // 2. MCP server (background within this process)
  const mcpHandle: ServerHandle = await startServer(paths);

  // 3. Dashboard (optional — non-fatal if it fails)
  let dashboardHandle: DashboardServerHandle | null = null;
  try {
    dashboardHandle = await startDashboard(paths, cfg.dashboardPort);
  } catch (err) {
    log.warn(`dashboard failed to start on port ${cfg.dashboardPort}: ${(err as Error).message}`);
  }

  // 4. Install hooks + register MCP so the IDE / external claude can see it
  await installHooks(paths);
  const mcpRegistered = await registerMcp(cfg.claudeBin, mcpHandle.port, projectRoot);

  let claudeExitCode = 0;
  try {
    if (launchCli) {
      claudeExitCode = await spawnClaude(cfg.claudeBin, {
        cwd: projectRoot,
        resumeSessionId: opts.resume,
      });
      log.info(`claude exited with code ${claudeExitCode}`);
    } else {
      printReadyBanner({
        projectRoot,
        scan,
        mcpUrl: mcpHandle.url,
        dashboardUrl: dashboardHandle?.url ?? null,
        mcpRegistered,
      });
      const sig = await waitForSignal();
      log.info(`received ${sig} — shutting down…`);
    }
  } finally {
    await unregisterMcp(cfg.claudeBin, projectRoot).catch(() => undefined);
    if (dashboardHandle) {
      await dashboardHandle
        .stop()
        .catch((err) => log.warn(`dashboard stop error: ${(err as Error).message}`));
    }
    await mcpHandle
      .stop()
      .catch((err) => log.warn(`MCP server stop error: ${(err as Error).message}`));
    await cleanup(paths).catch((err) => log.warn(`cleanup error: ${(err as Error).message}`));
  }
}

export function buildProgram() {
  const prog = sade("syn");
  prog.version(VERSION).describe("Local context engine for AI coding assistants.");

  prog
    .command(
      ". [path]",
      "Scan + MCP + dashboard + hooks. Default flow — use with the Claude Code IDE extension.",
      {
        default: true,
      },
    )
    .option("--resume <id>", "Resume an existing Claude session (only with --launch-cli)")
    .option("--launch-cli", "Also spawn `claude` CLI in this terminal (legacy M3 behavior)", false)
    .option("--full", "Re-parse every file, ignoring the incremental parse cache", false)
    .action(async (path: string | undefined, opts: DefaultOpts) => {
      await defaultFlow(path ?? ".", opts);
    });

  prog
    .command("scan [path]", "Scan only — walk + parse + write graph.")
    .option("--full", "Re-parse every file, ignoring the incremental parse cache", false)
    .action(async (path: string | undefined, opts: { full?: boolean }) => {
      await scanCommand(path ?? ".", { full: opts.full });
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

  prog
    .command("doctor [path]", "Diagnose this project's Synthra setup + environment.")
    .option("--report", "Emit a copy-pasteable markdown diagnostic (for GitHub issues)", false)
    .action(async (path: string | undefined, opts: { report?: boolean }) => {
      await doctorCommand(path ?? ".", { report: opts.report, version: VERSION });
    });

  prog
    .command(
      "remove [path]",
      "Remove Synthra from a project — deletes its state, strips hooks/policy/gitignore entries, deregisters MCP.",
    )
    .option("--yes", "Skip the confirmation prompt", false)
    .action(async (path: string | undefined, opts: { yes?: boolean }) => {
      await removeCommand(path ?? ".", { yes: opts.yes });
    });

  return prog;
}

export async function main(argv: string[]): Promise<void> {
  const prog = buildProgram();
  prog.parse(argv);
}
