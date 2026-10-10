// v0.41: Codex reaches Synthra through `syn mcp`, a stdio bridge that finds
// the project's server from the folder Codex runs in. These check the bridge
// with and without a server, across a restart on a new port, the read-only
// marks Codex uses to skip its approval prompt, and the doctor's Codex line.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexEntry } from "../src/cli/codex-command.js";
import { type DoctorCheck, runDoctorChecks } from "../src/cli/doctor-command.js";
import { createBridge, findProjectRoot } from "../src/cli/mcp-bridge.js";
import { startServer } from "../src/server/http.js";
import { listedTools } from "../src/server/mcp.js";
import { resolvePaths } from "../src/shared/paths.js";

const INIT = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.160.0" },
  },
};
const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

async function project(): Promise<{ root: string; sub: string }> {
  const root = await mkdtemp(join(tmpdir(), "syn-bridge-"));
  await mkdir(resolvePaths(root).graphDir, { recursive: true });
  const sub = join(root, "src", "deep");
  await mkdir(sub, { recursive: true });
  return { root, sub };
}

/** A JSON-RPC answer, read loosely: each test checks the fields it needs. */
// biome-ignore lint/suspicious/noExplicitAny: test-only view of the answer
type Answer = { result?: any; error?: any };

async function ask(bridge: Awaited<ReturnType<typeof createBridge>>, msg: unknown) {
  const out = await bridge.handle(JSON.stringify(msg));
  return out === null ? null : (JSON.parse(out) as Answer);
}

const codexLine = async (port: number) =>
  (
    (await (await fetch(`http://127.0.0.1:${port}/doctor`)).json()) as { checks: DoctorCheck[] }
  ).checks.find((c) => c.label === "Codex");

describe("syn mcp finds the project", () => {
  it("walks up to the nearest mapped folder", async () => {
    const { root, sub } = await project();
    expect(await findProjectRoot(sub)).toBe(root);
    const bare = await mkdtemp(join(tmpdir(), "syn-bridge-none-"));
    // A temp folder is never inside a mapped project.
    expect(await findProjectRoot(bare)).toBeNull();
  });
});

describe("syn mcp with no server running", () => {
  it("still shakes hands and lists the tools, and a call says how to start Synthra", async () => {
    const { root, sub } = await project();
    const bridge = await createBridge(sub, "1.2.3");
    const init = await ask(bridge, INIT);
    expect(init?.result.protocolVersion).toBe("2025-06-18");
    expect(init?.result.serverInfo).toEqual({ name: "synthra", version: "1.2.3" });
    expect(await ask(bridge, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = await ask(bridge, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list?.result.tools.map((t: { name: string }) => t.name)).toContain("graph_read");
    const res = await ask(bridge, call(2, "graph_read", { target: "a.ts" }));
    expect(res?.result.isError).toBe(true);
    expect(res?.result.content[0].text).toContain(`Synthra isn't running for ${root}`);
  });

  it("outside any mapped folder, says to run syn . first", async () => {
    const bare = await mkdtemp(join(tmpdir(), "syn-bridge-none-"));
    const bridge = await createBridge(bare, "1.2.3");
    const res = await ask(bridge, call(1, "find_symbol", { name: "x" }));
    expect(res?.result.content[0].text).toContain("Run `syn .`");
  });

  it("answers bad input with JSON-RPC errors, never with silence", async () => {
    const { sub } = await project();
    const bridge = await createBridge(sub, "1.2.3");
    expect(JSON.parse((await bridge.handle("{not json")) as string).error.code).toBe(-32700);
    expect(JSON.parse((await bridge.handle("[1,2]")) as string).error.code).toBe(-32600);
    expect(await bridge.handle("   ")).toBeNull();
  });
});

describe("syn mcp with the project's server", () => {
  it("forwards to it, and the server records a Codex connection apart from Claude's", async () => {
    const { root, sub } = await project();
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    const handle = await startServer(resolvePaths(root), { version: "9.9.9" });
    try {
      const bridge = await createBridge(sub, "1.2.3");
      // The server answered (its package version), not the bridge ("1.2.3").
      expect((await ask(bridge, INIT))?.result.serverInfo.version).not.toBe("1.2.3");
      const res = await ask(bridge, call(1, "count_tokens", { text: "abcdefgh" }));
      expect(JSON.parse(res?.result.content[0].text).tokens).toBe(2);
      const codex = await codexLine(handle.port);
      expect(codex?.detail).toContain("Codex 0.160.0 uses Synthra's tools through `syn mcp`");
      const doc = (await (await fetch(`http://127.0.0.1:${handle.port}/doctor`)).json()) as {
        checks: DoctorCheck[];
      };
      // Claude never connected here: Codex's session must not count as Claude's.
      expect(doc.checks.find((c) => c.label === "Claude connection")?.detail).not.toContain(
        "Codex",
      );
    } finally {
      await handle.stop();
    }
  }, 30_000);

  it("follows the server to a new port after a restart, and greets it again", async () => {
    const { root, sub } = await project();
    const first = await startServer(resolvePaths(root), { version: "1" });
    const bridge = await createBridge(sub, "x");
    await ask(bridge, INIT);
    await first.stop();
    const down = await ask(bridge, call(1, "count_tokens", { text: "abcd" }));
    expect(down?.result.isError).toBe(true);

    const second = await startServer(resolvePaths(root), { version: "2" });
    try {
      const up = await ask(bridge, call(2, "count_tokens", { text: "abcd" }));
      expect(JSON.parse(up?.result.content[0].text).tokens).toBe(1);
      // The new server never saw Codex's initialize itself: the bridge replayed it.
      expect((await codexLine(second.port))?.detail).toContain("Codex 0.160.0");
    } finally {
      await second.stop();
    }
  }, 30_000);
});

describe("read-only marks (Codex runs these without asking)", () => {
  it("marks the tools that only read, and none that write", () => {
    const tools = listedTools() as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    const ro = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(ro).toEqual(
      expect.arrayContaining(["graph_continue", "graph_read", "find_symbol", "blast_radius"]),
    );
    for (const w of ["graph_register_edit", "context_remember", "memory", "skill_manage"]) {
      expect(ro, w).not.toContain(w);
    }
  });
});

describe("the doctor's Codex line", () => {
  const lineFor = async (config: string | null) => {
    const dir = await mkdtemp(join(tmpdir(), "syn-codex-doc-"));
    const file = join(dir, "config.toml");
    if (config !== null) await writeFile(file, config);
    const checks = await runDoctorChecks(dir, { environment: false, codexConfig: file });
    return checks.find((c) => c.label === "Codex");
  };

  it("stays out of the way without Codex", async () => {
    expect(await lineFor(null)).toBeUndefined();
  });

  it("suggests syn codex when Codex has no Synthra entry", async () => {
    const c = await lineFor('model = "x"\n\n[mcp_servers.other]\ncommand = "npx"\n');
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("run `syn codex`");
  });

  it("is happy with syn mcp, and warns about any other command", async () => {
    expect(
      (await lineFor('[mcp_servers.synthra]\ncommand = "syn"\nargs = ["mcp"]\n'))?.status,
    ).toBe("ok");
    const bad = await lineFor('[mcp_servers.synthra]\ncommand = "node"\nargs = ["old.js"]\n');
    expect(bad?.status).toBe("warn");
  });

  it("reads only the synthra table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-codex-entry-"));
    const file = join(dir, "config.toml");
    await writeFile(
      file,
      "[mcp_servers.synthra_old]\ncommand = \"x\"\n\n[mcp_servers.synthra]\ncommand = 'syn'\n",
    );
    expect(await codexEntry(file)).toEqual({ present: true, command: "syn" });
  });
});
