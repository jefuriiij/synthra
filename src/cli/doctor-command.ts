// `syn doctor` — read-only diagnosis of a project's Synthra setup + environment.
// Surfaces the common failure modes the dogfood log kept hitting: missing `jq`
// (Stop/PreToolUse bash hooks silently no-op → no token logging or gating), a
// stale or 0-symbol graph, no `.mcp.json` (the IDE can't see graph_* tools), and
// an outdated policy block / uninstalled hooks. Never mutates anything.

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import spawn from "cross-spawn";

import { SCHEMA_VERSION } from "../graph/types.js";
import type { GraphSchema } from "../graph/types.js";
import { POLICY_VERSION } from "../hooks/claude-md.js";
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

/** Collect the diagnostic checks for a project. Pure of console output so it can
 *  be tested; doctorCommand() wraps it with printing. */
export async function runDoctorChecks(projectRoot: string): Promise<DoctorCheck[]> {
  const paths = resolvePaths(projectRoot);
  const cfg = loadConfig();
  const checks: DoctorCheck[] = [];

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
  const hasClaude = await binWorks(cfg.claudeBin, ["--version"]);
  checks.push(
    hasClaude
      ? { status: "ok", label: "claude CLI", detail: `'${cfg.claudeBin}' on PATH` }
      : {
          status: "warn",
          label: "claude CLI",
          detail: `'${cfg.claudeBin}' not found — MCP registration + IDE need it (set SYN_CLAUDE_BIN to override).`,
        },
  );

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
    const s = await readFile(paths.claudeSettings, "utf8");
    checks.push(
      s.includes("synthra-hook=true")
        ? { status: "ok", label: "Hooks", detail: "registered in .claude/settings.local.json" }
        : {
            status: "warn",
            label: "Hooks",
            detail: "settings.local.json present but no Synthra hooks — run `syn .`.",
          },
    );
  }

  return checks;
}

export async function doctorCommand(rawPath: string): Promise<void> {
  const projectRoot = resolve(rawPath);
  const checks = await runDoctorChecks(projectRoot);

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
