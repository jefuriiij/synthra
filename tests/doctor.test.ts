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
import { claudePolicy } from "../src/cli/claude-policy.js";
import { SCHEMA_VERSION } from "../src/graph/types.js";
import { POLICY_VERSION } from "../src/hooks/claude-md.js";

const find = (checks: DoctorCheck[], label: string) => checks.find((c) => c.label === label);

interface HookEntry {
  hooks: Array<{ type: string; command: string; meta?: string }>;
}

/** A settings file with `copies` registrations of our Stop hook. Two or more is
 *  the duplicate-registration bug; the command path is what identifies them. */
const hookSettings = (copies: number): { hooks: { Stop: HookEntry[] } } => ({
  hooks: {
    Stop: Array.from({ length: copies }, () => ({
      hooks: [
        {
          type: "command",
          command: 'bash "/p/.claude/hooks/synthra-stop.sh"',
          meta: "synthra-hook=true" as string | undefined,
        },
      ],
    })),
  },
});

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
    // Not running and not registered: Synthra removes its entry when it stops.
    expect(find(checks, "MCP registration")?.status).toBe("ok");
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
    await writeFile(join(dir, ".claude", "settings.local.json"), JSON.stringify(hookSettings(1)));

    const checks = await runDoctorChecks(dir);
    expect(find(checks, "Graph")?.status).toBe("ok");
    expect(find(checks, "MCP registration")?.status).toBe("ok");
    expect(find(checks, "CLAUDE.md policy")?.status).toBe("ok");
    expect(find(checks, "Hooks")?.status).toBe("ok");
  });

  // Claude Code drops the `meta` marker when it rewrites settings.local.json.
  // Doctor used to look for that key alone, so it announced "no Synthra hooks —
  // run `syn .`" about an install whose hooks were present and firing.
  it("still sees the hooks after the meta marker is dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-"));
    await mkdir(join(dir, ".claude"), { recursive: true });
    const settings = hookSettings(1);
    for (const entry of settings.hooks.Stop) for (const h of entry.hooks) h.meta = undefined;
    await writeFile(join(dir, ".claude", "settings.local.json"), JSON.stringify(settings));

    expect(find(await runDoctorChecks(dir), "Hooks")?.status).toBe("ok");
  });

  // The duplicate-registration bug that the marker loss caused: each extra copy
  // is another run of the same hook on every single event.
  it("warns when a hook is registered more than once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-"));
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.local.json"), JSON.stringify(hookSettings(3)));

    const hooks = find(await runDoctorChecks(dir), "Hooks");
    expect(hooks?.status).toBe("warn");
    expect(hooks?.detail).toContain("3");
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

// v0.40 — doctor checks what Claude Code really loaded, not only which files
// exist: an MCP entry at the right port, a live connection from Claude, and
// no Claude Code setting that switches Synthra's hooks or tools off.
describe("MCP registration, Claude connection and policy (v0.40)", () => {
  async function project(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-reg-"));
    await mkdir(join(dir, ".synthra-graph"), { recursive: true });
    await writeFile(join(dir, ".synthra-graph", "mcp_port"), "8123", "utf8");
    return dir;
  }
  const mcpJson = (port: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      mcpServers: { synthra: { type: "http", url: `http://127.0.0.1:${port}/mcp`, ...extra } },
    });

  it("warns when Synthra runs but .mcp.json doesn't name it, or names another port", async () => {
    const dir = await project();
    let c = find(
      await runDoctorChecks(dir, { environment: false, selfPort: 8123 }),
      "MCP registration",
    );
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("doesn't name it");

    await writeFile(join(dir, ".mcp.json"), mcpJson(9000));
    c = find(
      await runDoctorChecks(dir, { environment: false, selfPort: 8123 }),
      "MCP registration",
    );
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain(":9000");

    await writeFile(join(dir, ".mcp.json"), mcpJson(8123, { alwaysLoad: true }));
    c = find(
      await runDoctorChecks(dir, { environment: false, selfPort: 8123 }),
      "MCP registration",
    );
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("map tools kept loaded");
  });

  it("says whether Claude really connected to Synthra's tools", async () => {
    const dir = await project();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const opts = { environment: false, selfPort: 8123, startedAt };

    // Nobody worked here since the start: nothing to say.
    let c = find(await runDoctorChecks(dir, { ...opts, connection: null }), "Claude connection");
    expect(c?.status).toBe("ok");

    // Hooks fired after the start, but Claude never connected: a warning.
    await writeFile(
      join(dir, ".synthra-graph", "heartbeat.json"),
      JSON.stringify({ version: "x", hooks: { reply: new Date().toISOString() } }),
    );
    c = find(await runDoctorChecks(dir, { ...opts, connection: null }), "Claude connection");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("never connected");

    const now = new Date().toISOString();
    c = find(
      await runDoctorChecks(dir, {
        ...opts,
        connection: {
          client: "claude-code",
          clientVersion: "2.1.292",
          protocol: "2025-11-25",
          at: now,
          lastSeen: now,
        },
      }),
      "Claude connection",
    );
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("Claude Code 2.1.292");
    expect(c?.detail).toContain("MCP 2025-11-25");
  });

  it("finds Claude Code settings that switch Synthra's hooks or tools off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-policy-proj-"));
    const home = await mkdtemp(join(tmpdir(), "syn-policy-home-"));
    const sys = await mkdtemp(join(tmpdir(), "syn-policy-sys-"));
    expect(await claudePolicy(dir, { home, systemDir: sys })).toEqual([]);

    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ disableAllHooks: true }),
    );
    await writeFile(
      join(sys, "managed-settings.json"),
      JSON.stringify({
        deniedMcpServers: [{ serverName: "synthra" }],
        allowedMcpServers: [{ serverName: "github" }],
      }),
    );
    await writeFile(join(sys, "managed-mcp.json"), "{}");
    const found = await claudePolicy(dir, { home, systemDir: sys });
    expect(found.map((f) => f.status)).toEqual(["fail", "fail", "warn", "warn"]);
    expect(found[0]?.text).toContain(".claude/settings.json");
    expect(found[1]?.text).toContain("deniedMcpServers");
    expect(found[2]?.text).toContain("allowedMcpServers");
    expect(found[3]?.text).toContain("managed-mcp.json");

    // An allowlist that names Synthra is fine.
    await writeFile(
      join(sys, "managed-settings.json"),
      JSON.stringify({ allowedMcpServers: [{ serverName: "synthra" }] }),
    );
    await writeFile(join(dir, ".claude", "settings.json"), "{}");
    await writeFile(join(sys, "managed-mcp.json"), "");
    const ok = await claudePolicy(dir, { home, systemDir: sys });
    expect(ok.map((f) => f.text).join()).not.toContain("allowedMcpServers");
  });
});
