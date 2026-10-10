// `syn codex`: give Codex Synthra's map tools (v0.41). One entry in Codex's
// global MCP list starts `syn mcp`, which finds the project's server from the
// folder Codex runs in (see mcp-bridge.ts). So it is set up once per machine,
// not per project. `--remove` takes the entry out again.

import spawn from "cross-spawn";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "../shared/logger.js";

export const CODEX_MCP_NAME = "synthra";
/** What Codex runs: `syn mcp`, through the PATH like `npx` in its own list. */
export const CODEX_MCP_COMMAND = ["syn", "mcp"];

function runCodex(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    const proc = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c) => (stderr += String(c)));
    proc.on("error", () => done({ code: -1, stderr: "codex is not on the PATH" }));
    proc.on("exit", (code) => done({ code: code ?? 0, stderr }));
  });
}

/** Codex's config file: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
export function codexConfigPath(env = process.env, home = homedir()): string {
  return join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
}

/** Whether Codex's config names Synthra's server, and with what command.
 *  A plain text look, not a TOML parser: Codex writes this table itself. */
export async function codexEntry(
  file = codexConfigPath(),
): Promise<{ present: boolean; command?: string } | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const table = text.split(/^\[/m).find((t) => /^mcp_servers\.synthra\]/.test(t));
  if (!table) return { present: false };
  const command = /^command\s*=\s*["']([^"']*)["']/m.exec(table)?.[1];
  return command === undefined ? { present: true } : { present: true, command };
}

export async function codexCommand(opts: { remove?: boolean } = {}): Promise<void> {
  // `codex mcp add` replaces an entry of the same name (Codex 0.160).
  const args = opts.remove
    ? ["mcp", "remove", CODEX_MCP_NAME]
    : ["mcp", "add", CODEX_MCP_NAME, "--", ...CODEX_MCP_COMMAND];
  const result = await runCodex(args);
  if (result.code !== 0) {
    log.error(
      result.code === -1
        ? "Codex isn't installed, or `codex` is not on the PATH."
        : `codex ${args.slice(0, 2).join(" ")} failed (code ${result.code}): ${result.stderr.trim()}`,
    );
    process.exitCode = 1;
    return;
  }
  if (opts.remove) {
    log.info("Codex no longer starts Synthra. New Codex sessions won't have its tools.");
    return;
  }
  log.info("Codex now starts Synthra's tools in every project Synthra has mapped.");
  log.info("Start a new Codex session to use them. The map tools run without asking;");
  log.info("tools that write (memory, skills) ask you first.");
}
