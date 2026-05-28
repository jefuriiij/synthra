// `syn` entry point. Parses args and dispatches to commands.
// Commands implemented in M1:
//   syn scan [path]       → walk + parse + write graph
//   syn .                 → alias for `syn scan .` (M3 will chain start-claude)
// Stubs (M2-M6) print a "not yet implemented" message rather than crash.

import sade from "sade";

import { log } from "../shared/logger.js";
import { scanCommand } from "./scan-command.js";

const VERSION = "0.0.1";

function notYet(name: string, milestone: string): () => void {
  return () => {
    log.error(`'${name}' is not yet implemented (${milestone}).`);
    process.exit(2);
  };
}

export function buildProgram() {
  const prog = sade("syn");
  prog
    .version(VERSION)
    .describe("Local context engine for AI coding assistants.");

  prog
    .command("scan [path]", "Scan a project and write the context graph.", { default: true })
    .example("scan")
    .example("scan ./packages/api")
    .action(async (path: string | undefined) => {
      await scanCommand(path ?? ".");
    });

  prog
    .command(". [path]", "Alias for `scan`. M3 will also launch Claude Code.")
    .action(async (path: string | undefined) => {
      await scanCommand(path ?? ".");
    });

  prog.command("serve [path]", "Start the MCP server only.").action(notYet("serve", "M2"));
  prog.command("dashboard", "Open the token dashboard.").action(notYet("dashboard", "M6"));

  return prog;
}

export async function main(argv: string[]): Promise<void> {
  const prog = buildProgram();
  prog.parse(argv);
}

main(process.argv).catch((err) => {
  log.error("fatal:", err?.message ?? String(err));
  if (err?.stack) log.debug(err.stack);
  process.exit(1);
});
