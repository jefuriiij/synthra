// `syn doctor` diagnostic checks (#9) + the shareable diagnostic report (v0.17).

import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
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

describe("MCP server check (v0.26)", () => {
  // Every hook script ends in `catch { exit 0 }`, so a dead or hijacked port
  // produces no error anywhere — the Moat just stops gating and CONTEXT.md just
  // stops refreshing. `syn doctor` is where that becomes visible.
  async function healthServer(servedRoot: string): Promise<{ port: number; close: () => void }> {
    const server = createServer((req, res) => {
      if (req.url !== "/health") return void res.writeHead(404).end("{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, project_root: servedRoot, pid: 1234, port: 0 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as { port: number }).port, close: () => server.close() };
  }

  async function projectWithPort(port: number | string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-mcp-"));
    await mkdir(join(dir, ".synthra-graph"), { recursive: true });
    await writeFile(join(dir, ".synthra-graph", "mcp_port"), String(port), "utf8");
    return dir;
  }

  it("is OK when no server is running (nothing stale to clean up)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-"));
    expect(find(await runDoctorChecks(dir), "MCP server")?.status).toBe("ok");
  });

  it("warns that hooks are silently no-oping when the port is dead", async () => {
    const s = await healthServer("unused");
    s.close(); // free the port, then point the project at it
    const dir = await projectWithPort(s.port);

    const check = find(await runDoctorChecks(dir), "MCP server");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("stale port file");
  });

  it("fails when the port is served by a different project", async () => {
    const s = await healthServer("C:/work/somebody-else");
    try {
      const dir = await projectWithPort(s.port);
      const check = find(await runDoctorChecks(dir), "MCP server");
      expect(check?.status).toBe("fail");
      expect(check?.detail).toContain("different project");
    } finally {
      s.close();
    }
  });

  it("is OK when the port serves this project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-mcp-"));
    const s = await healthServer(dir);
    try {
      await mkdir(join(dir, ".synthra-graph"), { recursive: true });
      await writeFile(join(dir, ".synthra-graph", "mcp_port"), String(s.port), "utf8");
      const check = find(await runDoctorChecks(dir), "MCP server");
      expect(check?.status).toBe("ok");
      expect(check?.detail).toContain(`:${s.port}`);
    } finally {
      s.close();
    }
  });

  it("warns on a garbage port file", async () => {
    const dir = await projectWithPort("not-a-port");
    expect(find(await runDoctorChecks(dir), "MCP server")?.status).toBe("warn");
  });
});

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

  it("redacts a foreign project root leaked by the MCP server check", () => {
    const home = homedir();
    const checks: DoctorCheck[] = [
      { status: "fail", label: "MCP server", detail: `:8081 is served by ${home}\\other-project` },
    ];
    expect(buildDiagnosticReport(checks, info)).not.toContain(home);
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
