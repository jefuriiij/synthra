// `syn` entry point. Parses args and dispatches to commands.
// Commands:
//   syn .                 → bootstrap + scan + start MCP + launch claude
//   syn scan [path]       → scan only, write graph
//   syn serve [path]      → start MCP server only
//   syn dashboard         → open the token dashboard
//   syn --resume <id>     → resume a session by Claude session id
// TODO: M1 — wire bootstrap + scan; M3 — wire start-claude

import { log } from "../shared/logger.js";

export async function main(argv: string[]): Promise<void> {
  log.info("syn v0.0.1 — not yet implemented");
  log.info("argv:", JSON.stringify(argv.slice(2)));
  // TODO: parse args with sade, dispatch to commands
  process.exit(0);
}

main(process.argv).catch((err) => {
  log.error("fatal:", err?.message ?? String(err));
  process.exit(1);
});
