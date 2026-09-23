// `syn doctor` — read-only diagnosis of a project's Synthra setup + environment.
// Surfaces the common failure modes the dogfood log kept hitting: missing `jq`
// (Stop/PreToolUse bash hooks silently no-op → no token logging or gating), a
// stale or 0-symbol graph, no `.mcp.json` (the IDE can't see graph_* tools), and
// an outdated policy block / uninstalled hooks. Never mutates anything.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import spawn from "cross-spawn";

import { SCHEMA_VERSION } from "../graph/types.js";
import type { GraphSchema } from "../graph/types.js";
import { POLICY_VERSION } from "../hooks/claude-md.js";
import { ourHookCounts, type HooksConfig } from "../hooks/hooks-config.js";
import { probeHealth, sameRoot } from "../server/owner.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { resolvePaths } from "../shared/paths.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  status: CheckStatus;
  label: string;
  detail: string;
}

const ICON: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️", fail: "❌" };

function binWorks(bin: string, args: string[]): Promise<boolean> {
  return new Promise((res) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { stdio: "ignore" });
    } catch {
      res(false);
      return;
    }
    proc.on("error", () => res(false));
    proc.on("exit", (code) => res(code === 0));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `MCP server` check: read the port file the hooks read, then ask whoever
 * holds that port who they serve.
 *
 * Three distinct failures hide behind "the port file exists":
 *   - nobody is listening → the file is a corpse from a hard kill, and hooks
 *     have been no-oping silently ever since;
 *   - someone is listening but serves another project → that port was recycled,
 *     so this project's hooks are reading and writing *their* state;
 *   - it's a live server for this project → all good.
 */
async function checkMcpServer(portFile: string, projectRoot: string): Promise<DoctorCheck> {
  const label = "MCP server";
  let raw: string;
  try {
    raw = (await readFile(portFile, "utf8")).trim();
  } catch {
    return {
      status: "ok",
      label,
      detail: "not running (no mcp_port) — hooks stay inert until you run `syn .` here.",
    };
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    return { status: "warn", label, detail: `mcp_port is not a port number (${raw || "empty"}).` };
  }

  const health = await probeHealth(port);
  if (!health) {
    return {
      status: "warn",
      label,
      detail: `stale port file — nothing is listening on :${port}, so every hook silently no-ops (no gating, no CONTEXT.md refresh). Run \`syn .\` here.`,
    };
  }
  if (!sameRoot(health.project_root, projectRoot)) {
    return {
      status: "fail",
      label,
      detail: `:${port} is served by a different project (${health.project_root}) — this project's hooks are talking to it. Run \`syn .\` here to take a fresh port.`,
    };
  }
  return { status: "ok", label, detail: `listening on :${port} (pid ${health.pid})` };
}

/**
 * The `MCP server` check as run BY the server, about itself (`GET /doctor`).
 *
 * Probing our own /health over HTTP from inside a request handler would work,
 * but it proves nothing — we are obviously alive, we are answering. The failure
 * that matters from in here is the port file naming somebody else: the hooks
 * read `mcp_port`, so if it no longer says our port, every hook in this project
 * is talking to another process while we sit here looking healthy.
 */
async function checkSelfPort(portFile: string, selfPort: number): Promise<DoctorCheck> {
  const label = "MCP server";
  let raw: string;
  try {
    raw = (await readFile(portFile, "utf8")).trim();
  } catch {
    return {
      status: "fail",
      label,
      detail: `mcp_port is missing — this server is up on :${selfPort}, but the hooks can't find it, so every hook silently no-ops. Restart Synthra.`,
    };
  }
  if (Number(raw) !== selfPort) {
    return {
      status: "fail",
      label,
      detail: `mcp_port says :${raw || "(empty)"} but this server is :${selfPort} — the hooks are talking to someone else. Restart Synthra.`,
    };
  }
  return { status: "ok", label, detail: `listening on :${selfPort} (pid ${process.pid})` };
}

export interface DoctorCheckOptions {
  /** Include the checks that spawn processes (Node, jq, `claude --version`).
   *  Default true. The IDE extension polls with this off: the environment
   *  doesn't change between polls, and `claude --version` alone is a Node
   *  cold start every few minutes for nothing. */
  environment?: boolean;
  /** Set when the server runs the checks about itself — swaps the HTTP
   *  self-probe for a direct port-file comparison (see checkSelfPort). */
  selfPort?: number;
}

/** The worst status in a set of checks — what the IDE status bar shows. */
export function worstStatus(checks: DoctorCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

/** Collect the diagnostic checks for a project. Pure of console output so it can
 *  be tested; doctorCommand() wraps it with printing. */
export async function runDoctorChecks(
  projectRoot: string,
  opts: DoctorCheckOptions = {},
): Promise<DoctorCheck[]> {
  const paths = resolvePaths(projectRoot);
  const cfg = loadConfig();
  const checks: DoctorCheck[] = [];
  if (opts.environment !== false) await environmentChecks(checks, cfg.claudeBin);

  await projectChecks(checks, projectRoot, paths, opts.selfPort);
  return checks;
}

async function environmentChecks(checks: DoctorCheck[], claudeBin: string): Promise<void> {
  // Node version
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 18
      ? { status: "ok", label: "Node", detail: `v${process.versions.node}` }
      : {
          status: "fail",
          label: "Node",
          detail: `v${process.versions.node} — Synthra needs Node >= 18`,
        },
  );

  // jq — required by the bash hooks; on Windows the installer uses .ps1 instead.
  const hasJq = await binWorks("jq", ["--version"]);
  if (process.platform === "win32") {
    checks.push({
      status: "ok",
      label: "jq",
      detail: hasJq
        ? "present (not required — Windows uses .ps1 hooks)"
        : "not required on Windows (.ps1 hooks)",
    });
  } else {
    checks.push(
      hasJq
        ? { status: "ok", label: "jq", detail: "present" }
        : {
            status: "warn",
            label: "jq",
            detail:
              "missing — Stop/PreToolUse bash hooks silently no-op (no token logging or gating). Install jq (brew/apt).",
          },
    );
  }

  // claude CLI — needed for MCP registration + IDE integration.
  const hasClaude = await binWorks(claudeBin, ["--version"]);
  checks.push(
    hasClaude
      ? { status: "ok", label: "claude CLI", detail: `'${claudeBin}' on PATH` }
      : {
          status: "warn",
          label: "claude CLI",
          detail: `'${claudeBin}' not found — MCP registration + IDE need it (set SYN_CLAUDE_BIN to override).`,
        },
  );
}

async function projectChecks(
  checks: DoctorCheck[],
  projectRoot: string,
  paths: ReturnType<typeof resolvePaths>,
  selfPort: number | undefined,
): Promise<void> {
  // Graph
  if (!(await exists(paths.infoGraph))) {
    checks.push({
      status: "warn",
      label: "Graph",
      detail: "no info_graph.json — run `syn .` (or `syn scan`) here.",
    });
  } else {
    try {
      const graph = JSON.parse(await readFile(paths.infoGraph, "utf8")) as GraphSchema;
      const parts = [`${graph.symbol_count} symbols`, `${graph.file_count} files`];
      let status: CheckStatus = "ok";
      const ageMs = Date.now() - Date.parse(graph.generated_at);
      if (Number.isFinite(ageMs))
        parts.push(`scanned ${Math.max(0, Math.round(ageMs / 60000))}m ago`);
      if (graph.schema_version !== SCHEMA_VERSION) {
        status = "warn";
        parts.push(`schema v${graph.schema_version} ≠ v${SCHEMA_VERSION} (auto-rescans on serve)`);
      }
      if (graph.symbol_count === 0) {
        status = "warn";
        parts.push("0 symbols — unsupported language or nothing indexed");
      }
      checks.push({ status, label: "Graph", detail: parts.join(" · ") });
    } catch {
      checks.push({
        status: "warn",
        label: "Graph",
        detail: "info_graph.json unreadable — re-run `syn scan`.",
      });
    }
  }

  // Is a server actually reachable on the port the hooks will use?
  //
  // Worth its own check because the failure is invisible: every hook script
  // ends in `catch { exit 0 }`, so a dead port means the Moat stops gating and
  // CONTEXT.md stops refreshing with nothing logged anywhere.
  checks.push(
    selfPort === undefined
      ? await checkMcpServer(paths.mcpPort, projectRoot)
      : await checkSelfPort(paths.mcpPort, selfPort),
  );

  // MCP registration for the IDE (.mcp.json at the project root)
  checks.push(
    (await exists(join(projectRoot, ".mcp.json")))
      ? {
          status: "ok",
          label: "MCP registration",
          detail: ".mcp.json present (IDE can see graph_* tools)",
        }
      : {
          status: "warn",
          label: "MCP registration",
          detail: "no .mcp.json — the IDE extension won't see Synthra's tools; run `syn .`.",
        },
  );

  // CLAUDE.md policy block
  if (!(await exists(paths.claudeMd))) {
    checks.push({
      status: "warn",
      label: "CLAUDE.md policy",
      detail: "no CLAUDE.md — run `syn .` to scaffold + inject the policy block.",
    });
  } else {
    const md = await readFile(paths.claudeMd, "utf8");
    if (md.includes(`synthra-policy v${POLICY_VERSION} BEGIN`)) {
      checks.push({
        status: "ok",
        label: "CLAUDE.md policy",
        detail: `policy block v${POLICY_VERSION}`,
      });
    } else {
      const m = md.match(/synthra-policy v(\d+) BEGIN/);
      checks.push({
        status: "warn",
        label: "CLAUDE.md policy",
        detail: m
          ? `policy block is v${m[1]}, current is v${POLICY_VERSION} — re-run \`syn .\` to refresh.`
          : "no synthra-policy block — run `syn .`.",
      });
    }
  }

  // Hooks installed
  if (!(await exists(paths.claudeSettings))) {
    checks.push({
      status: "warn",
      label: "Hooks",
      detail: "no .claude/settings.local.json — run `syn .` to install hooks.",
    });
  } else {
    // Detect by script path, not by the `meta` marker: Claude Code co-owns this
    // file and drops that key when it rewrites it, which used to make doctor
    // report "no hooks" while every hook was installed and firing.
    const s = await readFile(paths.claudeSettings, "utf8");
    let counts: Map<string, number> | undefined;
    try {
      counts = ourHookCounts(JSON.parse(s) as HooksConfig);
    } catch {
      counts = undefined;
    }
    const worst = counts ? Math.max(0, ...counts.values()) : 0;
    if (!counts) {
      checks.push({
        status: "warn",
        label: "Hooks",
        detail: "settings.local.json is not valid JSON — hook state unknown.",
      });
    } else if (worst === 0) {
      checks.push({
        status: "warn",
        label: "Hooks",
        detail: "settings.local.json present but no Synthra hooks — run `syn .`.",
      });
    } else if (worst > 1) {
      checks.push({
        status: "warn",
        label: "Hooks",
        // Each extra copy is another run of the same hook on every event.
        detail: `registered ${worst}× in .claude/settings.local.json — every hook fires ${worst} times. Run \`syn .\` to repair.`,
      });
    } else {
      checks.push({
        status: "ok",
        label: "Hooks",
        detail: `registered in .claude/settings.local.json (${counts.size} events)`,
      });
    }
  }
}

/** Replace the user's home directory (either slash direction) with `~` so a
 *  shared diagnostic never leaks a username or machine path. */
export function redactHome(text: string, home = homedir()): string {
  if (!home) return text;
  const variants = [home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")];
  let out = text;
  for (const v of new Set(variants)) {
    out = out.split(v).join("~");
  }
  return out;
}

export interface ReportInfo {
  version: string;
  platform: string;
  arch: string;
  node: string;
  claudeBin: string;
}

/**
 * Copy-pasteable markdown diagnostic for GitHub issues — shared by
 * `syn doctor --report` and the dashboard's Report dialog (single source of
 * truth). Every line passes through redactHome; the project root is
 * deliberately not included.
 */
export function buildDiagnosticReport(checks: DoctorCheck[], info: ReportInfo): string {
  const lines = [
    "### Synthra diagnostic report",
    "",
    `- Synthra: v${info.version}`,
    `- OS: ${info.platform} ${info.arch}`,
    `- Node: v${info.node}`,
    `- claude bin: ${redactHome(info.claudeBin)}`,
    "",
  ];
  for (const c of checks) {
    lines.push(`- ${ICON[c.status]} **${c.label}** — ${redactHome(c.detail)}`);
  }
  return lines.join("\n");
}

export interface DoctorOptions {
  /** Emit the markdown diagnostic (raw stdout, pipe-friendly) instead of the
   *  human checklist. */
  report?: boolean;
  /** Synthra version for the report header (injected by the CLI entry). */
  version?: string;
}

export async function doctorCommand(rawPath: string, opts: DoctorOptions = {}): Promise<void> {
  const projectRoot = resolve(rawPath);
  const checks = await runDoctorChecks(projectRoot);

  if (opts.report) {
    console.log(
      buildDiagnosticReport(checks, {
        version: opts.version ?? "unknown",
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        claudeBin: loadConfig().claudeBin,
      }),
    );
    return;
  }

  log.info("");
  log.info(`  Synthra doctor — ${projectRoot}`);
  log.info("");
  for (const c of checks) {
    log.info(`  ${ICON[c.status]}  ${c.label.padEnd(18)}${c.detail}`);
  }
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  log.info("");
  log.info(
    fail === 0 && warn === 0 ? "  All checks passed." : `  ${fail} failed · ${warn} warning(s).`,
  );
  log.info("");
}
