// Subroutines for plugging Synthra into Claude Code:
//   - registerMcp     → `claude mcp add --transport http --scope local`
//   - unregisterMcp   → `claude mcp remove`
//   - spawnClaude     → spawn the terminal CLI (used only by `--launch-cli`)
//   - startClaude     → legacy composite (install hooks + register + spawn + unregister)
//     kept for any external callers; cli/index.ts now composes the pieces
//     itself so the default flow can skip the CLI spawn.

import spawn from "cross-spawn";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { installHooks } from "../hooks/installer.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";

const MCP_NAME = "synthra";

// We use `cross-spawn` instead of `node:child_process` so Windows .cmd
// shims (e.g. claude.cmd) resolve correctly without setting shell:true.
// shell:true triggers Node's DEP0190 deprecation because args get
// concatenated into a single command line with no escaping. cross-spawn
// handles shim resolution + proper arg escaping internally, so we avoid
// the deprecation and the underlying security concern in one move.
function runClaude(
  bin: string,
  args: string[],
  cwd: string,
  stdio: "inherit" | "pipe" = "pipe",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd,
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c) => (stdout += String(c)));
    proc.stderr?.on("data", (c) => (stderr += String(c)));
    proc.on("error", () => resolve({ code: -1, stdout, stderr: stderr || "claude not on PATH" }));
    proc.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export async function registerMcp(bin: string, mcpPort: number, cwd: string): Promise<boolean> {
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  await runClaude(bin, ["mcp", "remove", MCP_NAME, "--scope", "project"], cwd).catch(
    () => undefined,
  );
  const reg = await runClaude(
    bin,
    ["mcp", "add", MCP_NAME, "--transport", "http", "--scope", "project", url],
    cwd,
  );
  if (reg.code !== 0) {
    log.warn(`claude mcp add failed (code ${reg.code}). stderr: ${reg.stderr.trim()}`);
    log.warn(`Synthra's MCP tools won't be visible to Claude this session.`);
    return false;
  }
  log.info(`registered MCP with Claude: ${MCP_NAME} → ${url}`);
  return true;
}

/**
 * Remove our MCP registration on shutdown — but ONLY if it still points at us.
 *
 * `--scope project` is a single shared entry in .mcp.json, not one per process.
 * Before v0.26 a shutting-down server ran this unconditionally, so when two
 * `syn` instances shared a project, the first to exit deleted the *other's*
 * registration: Claude Code lost the synthra MCP server mid-session while a
 * healthy server was still listening, with both `claude mcp` calls exiting 0
 * and nothing logged above debug.
 */
export async function unregisterMcp(bin: string, cwd: string, ownPort?: number): Promise<void> {
  if (ownPort !== undefined) {
    const registered = await readRegisteredPort(cwd);
    if (registered !== null && registered !== ownPort) {
      log.debug(
        `leaving MCP registration alone — it points at :${registered}, not our :${ownPort}`,
      );
      return;
    }
  }
  const r = await runClaude(bin, ["mcp", "remove", MCP_NAME, "--scope", "project"], cwd);
  if (r.code === 0) log.debug("unregistered MCP server");
}

/** The port in .mcp.json's synthra entry — the same file `--scope project` writes. */
export async function readRegisteredPort(cwd: string): Promise<number | null> {
  try {
    const raw = await readFile(join(cwd, ".mcp.json"), "utf8");
    const url = (JSON.parse(raw) as McpJson)?.mcpServers?.[MCP_NAME]?.url;
    const m = typeof url === "string" ? /:(\d+)(?:\/|$)/.exec(url) : null;
    return m?.[1] ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface McpJson {
  mcpServers?: Record<string, { url?: string } | undefined>;
}

export interface SpawnClaudeOptions {
  cwd: string;
  resumeSessionId?: string;
  initialPrompt?: string;
}

export async function spawnClaude(bin: string, opts: SpawnClaudeOptions): Promise<number> {
  const args: string[] = [];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.initialPrompt) args.push(opts.initialPrompt);
  log.info(`launching ${bin} ${args.join(" ")}`);
  const result = await runClaude(bin, args, opts.cwd, "inherit");
  return result.code;
}

// Legacy composite — install hooks + register MCP + spawn claude + cleanup.
// cli/index.ts no longer relies on this; it composes the pieces above so the
// new default `syn .` flow can skip the CLI spawn. Kept for compatibility.
export interface StartClaudeOptions {
  paths: SynthraPaths;
  mcpPort: number;
  resumeSessionId?: string;
  initialPrompt?: string;
}

export async function startClaude(opts: StartClaudeOptions): Promise<number> {
  const bin = loadConfig().claudeBin;
  await installHooks(opts.paths);
  await registerMcp(bin, opts.mcpPort, opts.paths.projectRoot);
  const code = await spawnClaude(bin, {
    cwd: opts.paths.projectRoot,
    resumeSessionId: opts.resumeSessionId,
    initialPrompt: opts.initialPrompt,
  });
  await unregisterMcp(bin, opts.paths.projectRoot);
  return code;
}
