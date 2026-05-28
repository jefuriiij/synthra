// Registers Synthra's MCP with Claude Code, installs hooks, spawns `claude`.
// Waits for `claude` to exit (the user's Ctrl+C goes to claude first because
// of stdio:inherit). On exit, unregisters the MCP entry so subsequent
// `claude` invocations outside syn don't dangle.

import { spawn } from "node:child_process";

import { installHooks } from "../hooks/installer.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";

export interface StartClaudeOptions {
  paths: SynthraPaths;
  mcpPort: number;
  resumeSessionId?: string;
  initialPrompt?: string;
}

const MCP_NAME = "synthra";

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
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c) => (stdout += String(c)));
    proc.stderr?.on("data", (c) => (stderr += String(c)));
    proc.on("error", () => resolve({ code: -1, stdout, stderr: stderr || "claude not on PATH" }));
    proc.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function registerMcp(bin: string, port: number, cwd: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/mcp`;
  // Best-effort remove first so re-registration is clean.
  await runClaude(bin, ["mcp", "remove", MCP_NAME, "--scope", "local"], cwd).catch(() => undefined);
  const reg = await runClaude(
    bin,
    ["mcp", "add", MCP_NAME, "--transport", "http", "--scope", "local", url],
    cwd,
  );
  if (reg.code !== 0) {
    log.warn(`claude mcp add failed (code ${reg.code}). stderr: ${reg.stderr.trim()}`);
    log.warn(`Synthra's tools won't be visible to Claude this session.`);
  } else {
    log.info(`registered MCP server with Claude: ${MCP_NAME} → ${url}`);
  }
}

async function unregisterMcp(bin: string, cwd: string): Promise<void> {
  const r = await runClaude(bin, ["mcp", "remove", MCP_NAME, "--scope", "local"], cwd);
  if (r.code === 0) log.debug("unregistered MCP server");
}

export async function startClaude(opts: StartClaudeOptions): Promise<number> {
  const cfg = loadConfig();
  const bin = cfg.claudeBin;

  await installHooks(opts.paths);
  await registerMcp(bin, opts.mcpPort, opts.paths.projectRoot);

  const args: string[] = [];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.initialPrompt) args.push(opts.initialPrompt);

  log.info(`launching ${bin} ${args.join(" ")}`);

  const result = await runClaude(bin, args, opts.paths.projectRoot, "inherit");

  await unregisterMcp(bin, opts.paths.projectRoot);

  return result.code;
}
