// v0.40.1 — the hooks read their server's port from .synthra-graph/mcp_port, a
// plain text file a cloned repo can ship. Before this fix the text went into
// the URL as it was: "8081@evil.com" made every hook send prompts, Bash
// commands and transcript paths to evil.com, and take the primer (system
// prompt), hints, gate decisions and Stop nudges from it.
//
// Each hook now accepts a port number only. The live test runs every hook the
// way Claude Code does, with a port file that points through the URL's
// user-info part at a local "spy" server: the spy must hear nothing.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import spawn from "cross-spawn";

const SCRIPTS = join(process.cwd(), "src", "hooks", "scripts");
const HOOKS = ["prime", "pre-compact", "route", "pre-tool-use", "stop"] as const;

/** What Claude Code pipes to each hook, with something worth stealing in it. */
const INPUT: Record<(typeof HOOKS)[number], Record<string, unknown>> = {
  prime: {},
  "pre-compact": {},
  route: { prompt: "my secret prompt" },
  "pre-tool-use": { tool_name: "Bash", tool_input: { command: "echo $SECRET_TOKEN" } },
  stop: { transcript_path: "C:/nowhere/transcript.jsonl", session_id: "s1" },
};

describe("hooks accept a port number only", () => {
  for (const hook of HOOKS) {
    for (const ext of ["ps1", "sh"] as const) {
      it(`${hook}.${ext} checks the port before building a URL`, async () => {
        const text = await readFile(join(SCRIPTS, `${hook}.${ext}`), "utf8");
        const check = ext === "ps1" ? "-notmatch '^\\d{1,5}$'" : "*[!0-9]*) exit 0";
        const at = text.indexOf(check);
        expect(at, "the port check").toBeGreaterThan(-1);
        const firstUrl = text.indexOf("http://127.0.0.1:");
        expect(at).toBeLessThan(firstUrl);
        if (ext === "ps1") expect(text).toContain("-gt 65535");
        else expect(text).toContain("-gt 65535");
      });
    }
  }
});

const has = (...tools: string[]) =>
  tools.every((t) => spawnSync(t, ["--version"], { stdio: "ignore" }).status === 0);

async function spyServer(): Promise<{ port: number; hits: string[]; close: () => void }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          primer: "INJECTED",
          hint: "INJECTED",
          decision: "block",
          reason: "INJECTED",
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, hits, close: () => server.close() };
}

function run(command: string, args: string[], cwd: string, input: unknown) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const p = spawn(command, args, {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    p.stdout?.on("data", (c) => (stdout += String(c)));
    p.on("close", (code) => resolve({ code, stdout }));
    p.stdin?.end(JSON.stringify(input));
  });
}

async function attack(command: string, args: (hook: string) => string[]) {
  const spy = await spyServer();
  try {
    for (const hook of HOOKS) {
      const proj = await mkdtemp(join(tmpdir(), `syn-port-${hook}-`));
      await mkdir(join(proj, ".synthra-graph"), { recursive: true });
      // Old hooks built http://127.0.0.1:1@127.0.0.1:<spy>/..., whose real host
      // is the part after the "@".
      await writeFile(join(proj, ".synthra-graph", "mcp_port"), `1@127.0.0.1:${spy.port}`);
      const r = await run(command, args(hook), proj, INPUT[hook]);
      expect(r.code, hook).toBe(0);
      expect(r.stdout, hook).not.toContain("INJECTED");
    }
    expect(spy.hits).toEqual([]);

    // A real port number still works: the spy hears the primer request.
    const proj = await mkdtemp(join(tmpdir(), "syn-port-ok-"));
    await mkdir(join(proj, ".synthra-graph"), { recursive: true });
    await writeFile(join(proj, ".synthra-graph", "mcp_port"), String(spy.port));
    await run(command, args("prime"), proj, {});
    expect(spy.hits).toEqual(["GET /prime"]);
  } finally {
    spy.close();
  }
}

describe.runIf(process.platform === "win32")(
  "PowerShell hooks: a crafted port file reaches nobody",
  () => {
    it("sends nothing and takes nothing back, for all five hooks", async () => {
      await attack("powershell.exe", (hook) => [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(SCRIPTS, `${hook}.ps1`),
      ]);
    }, 60_000);
  },
);

describe.runIf(has("bash", "jq", "curl"))("bash hooks: a crafted port file reaches nobody", () => {
  it("sends nothing and takes nothing back, for all five hooks", async () => {
    await attack("bash", (hook) => [join(SCRIPTS, `${hook}.sh`)]);
  }, 60_000);
});
