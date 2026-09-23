// v0.32 — `GET /doctor`: `syn doctor`, served live by the running server.
//
// The IDE extension polls this to drive its status-bar health light. It exists
// because every serious Synthra failure so far has been silent — hooks
// registered seven times over, a dead port file no-oping every hook — and
// doctor could see them, but nobody runs doctor without a reason.

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctorChecks, worstStatus, type DoctorCheck } from "../src/cli/doctor-command.js";
import { startServer } from "../src/server/http.js";
import { resolvePaths } from "../src/shared/paths.js";

interface DoctorResponse {
  version: string;
  status: "ok" | "warn" | "fail";
  checks: DoctorCheck[];
}

async function getDoctor(port: number, query = ""): Promise<DoctorResponse> {
  const res = await fetch(`http://127.0.0.1:${port}/doctor${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DoctorResponse;
}

const labels = (r: DoctorResponse) => r.checks.map((c) => c.label);
const find = (r: DoctorResponse, label: string) => r.checks.find((c) => c.label === label);

describe("GET /doctor", () => {
  it("reports this server's version and the worst status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-route-"));
    const handle = await startServer(resolvePaths(dir), { version: "9.9.9" });
    try {
      const r = await getDoctor(handle.port);
      expect(r.version).toBe("9.9.9");
      // A bare temp dir has no CLAUDE.md, no hooks, no .mcp.json.
      expect(r.status).toBe("warn");
      expect(r.status).toBe(worstStatus(r.checks));
    } finally {
      await handle.stop();
    }
  });

  // The environment checks spawn processes — `claude --version` alone is a Node
  // cold start. The extension polls every few minutes, so they are opt-in.
  it("skips the process-spawning checks unless ?env=1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-route-"));
    const handle = await startServer(resolvePaths(dir), { version: "test" });
    try {
      const light = await getDoctor(handle.port);
      expect(labels(light)).not.toContain("Node");
      expect(labels(light)).not.toContain("claude CLI");

      const full = await getDoctor(handle.port, "?env=1");
      expect(labels(full)).toContain("Node");
      expect(labels(full)).toContain("claude CLI");
    } finally {
      await handle.stop();
    }
  });

  it("sees its own port as healthy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-route-"));
    const handle = await startServer(resolvePaths(dir), { version: "test" });
    try {
      const mcp = find(await getDoctor(handle.port), "MCP server");
      expect(mcp?.status).toBe("ok");
      expect(mcp?.detail).toContain(`:${handle.port}`);
    } finally {
      await handle.stop();
    }
  });

  // The failure a server can only see from the inside: it is up and answering,
  // but the hooks read mcp_port — and mcp_port no longer names it.
  it("fails when mcp_port names a different port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-route-"));
    const paths = resolvePaths(dir);
    const handle = await startServer(paths, { version: "test" });
    try {
      await writeFile(paths.mcpPort, String(handle.port + 1), "utf8");
      const r = await getDoctor(handle.port);
      expect(find(r, "MCP server")?.status).toBe("fail");
      expect(r.status).toBe("fail");
    } finally {
      await handle.stop();
    }
  });

  it("fails when mcp_port has gone missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-route-"));
    const paths = resolvePaths(dir);
    const handle = await startServer(paths, { version: "test" });
    try {
      await rm(paths.mcpPort, { force: true });
      expect(find(await getDoctor(handle.port), "MCP server")?.status).toBe("fail");
    } finally {
      await handle.stop();
    }
  });

  it("turns warn when the hooks are registered twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-route-"));
    const paths = resolvePaths(dir);
    await mkdir(paths.claudeDir, { recursive: true });
    const hook = { type: "command", command: 'bash "/p/.claude/hooks/synthra-stop.sh"' };
    await writeFile(
      paths.claudeSettings,
      JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }, { hooks: [hook] }] } }),
      "utf8",
    );
    const handle = await startServer(paths, { version: "test" });
    try {
      const hooks = find(await getDoctor(handle.port), "Hooks");
      expect(hooks?.status).toBe("warn");
      expect(hooks?.detail).toContain("2×");
    } finally {
      await handle.stop();
    }
  });
});

describe("worstStatus", () => {
  const c = (status: DoctorCheck["status"]): DoctorCheck => ({ status, label: "x", detail: "" });

  it("ranks fail over warn over ok", () => {
    expect(worstStatus([c("ok"), c("ok")])).toBe("ok");
    expect(worstStatus([c("ok"), c("warn")])).toBe("warn");
    expect(worstStatus([c("warn"), c("fail"), c("ok")])).toBe("fail");
    expect(worstStatus([])).toBe("ok");
  });
});

describe("runDoctorChecks options", () => {
  it("still runs the environment checks by default — `syn doctor` is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-doctor-opts-"));
    const checks = await runDoctorChecks(dir);
    expect(checks.map((x) => x.label)).toContain("Node");
  });
});
