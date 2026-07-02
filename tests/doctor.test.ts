// `syn doctor` diagnostic checks (#9) + the shareable diagnostic report (v0.17).

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDiagnosticReport,
  redactHome,
  runDoctorChecks,
  type DoctorCheck,
} from "../src/cli/doctor-command.js";
import { SCHEMA_VERSION } from "../src/graph/types.js";
import { POLICY_VERSION } from "../src/hooks/claude-md.js";

const find = (checks: DoctorCheck[], label: string) => checks.find((c) => c.label === label);

describe("runDoctorChecks", () => {
  it("warns on a bare project (no graph / .mcp.json / CLAUDE.md / hooks)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-"));
    const checks = await runDoctorChecks(dir);

    expect(find(checks, "Graph")?.status).toBe("warn");
    expect(find(checks, "MCP registration")?.status).toBe("warn");
    expect(find(checks, "CLAUDE.md policy")?.status).toBe("warn");
    expect(find(checks, "Hooks")?.status).toBe("warn");
    expect(find(checks, "Node")?.status).toBe("ok"); // tests run on Node >= 18
  });

  it("reports OK for a fully set-up project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-"));
    await mkdir(join(dir, ".synthra-graph"), { recursive: true });
    await mkdir(join(dir, ".claude"), { recursive: true });

    const graph = {
      root: dir,
      node_count: 2,
      edge_count: 0,
      file_count: 1,
      symbol_count: 1,
      nodes: [],
      edges: [],
      generated_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    };
    await writeFile(join(dir, ".synthra-graph", "info_graph.json"), JSON.stringify(graph));
    await writeFile(join(dir, ".mcp.json"), "{}");
    await writeFile(
      join(dir, "CLAUDE.md"),
      `<!-- synthra-policy v${POLICY_VERSION} BEGIN -->\nx\n`,
    );
    await writeFile(
      join(dir, ".claude", "settings.local.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ meta: "synthra-hook=true" }] }] } }),
    );

    const checks = await runDoctorChecks(dir);
    expect(find(checks, "Graph")?.status).toBe("ok");
    expect(find(checks, "MCP registration")?.status).toBe("ok");
    expect(find(checks, "CLAUDE.md policy")?.status).toBe("ok");
    expect(find(checks, "Hooks")?.status).toBe("ok");
  });

  it("warns on a stale-schema or 0-symbol graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-"));
    await mkdir(join(dir, ".synthra-graph"), { recursive: true });
    const graph = {
      root: dir,
      node_count: 0,
      edge_count: 0,
      file_count: 0,
      symbol_count: 0,
      nodes: [],
      edges: [],
      generated_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION + 99,
    };
    await writeFile(join(dir, ".synthra-graph", "info_graph.json"), JSON.stringify(graph));
    const checks = await runDoctorChecks(dir);
    expect(find(checks, "Graph")?.status).toBe("warn");
  });
});

describe("diagnostic report (v0.17)", () => {
  const info = {
    version: "0.17.0",
    platform: "darwin",
    arch: "arm64",
    node: "22.1.0",
    claudeBin: "claude",
  };

  it("redactHome replaces the home dir (both slash directions) with ~", () => {
    const home = homedir();
    expect(redactHome(home + "\\x")).toBe("~\\x");
    expect(redactHome(home.replace(/\\/g, "/") + "/y")).toBe("~/y");
    expect(redactHome("no paths here")).toBe("no paths here");
  });

  it("report carries version/OS/Node lines and one icon line per check", () => {
    const checks: DoctorCheck[] = [
      { status: "ok", label: "Node", detail: "v22.1.0" },
      { status: "warn", label: "jq", detail: "missing — hooks silently no-op" },
      { status: "fail", label: "Graph", detail: "broken" },
    ];
    const md = buildDiagnosticReport(checks, info);
    expect(md).toContain("### Synthra diagnostic report");
    expect(md).toContain("- Synthra: v0.17.0");
    expect(md).toContain("- OS: darwin arm64");
    expect(md).toContain("- Node: v22.1.0");
    expect(md).toContain("- ✅ **Node** — v22.1.0");
    expect(md).toContain("- ⚠️ **jq** — missing");
    expect(md).toContain("- ❌ **Graph** — broken");
  });

  it("redacts home paths in check details and claudeBin", () => {
    const home = homedir();
    const bin = home + "\\bin\\claude.cmd";
    const checks: DoctorCheck[] = [
      { status: "ok", label: "claude CLI", detail: `'${bin}' on PATH` },
    ];
    const md = buildDiagnosticReport(checks, { ...info, claudeBin: bin });
    expect(md).not.toContain(home);
    expect(md).toContain("~\\bin\\claude.cmd");
  });
});
