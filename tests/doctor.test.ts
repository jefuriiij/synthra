// `syn doctor` diagnostic checks (#9).

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctorChecks, type DoctorCheck } from "../src/cli/doctor-command.js";
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
    await writeFile(join(dir, "CLAUDE.md"), `<!-- synthra-policy v${POLICY_VERSION} BEGIN -->\nx\n`);
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
