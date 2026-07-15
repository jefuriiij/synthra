// Stop hook v0.20: the transcript pass also collects Task/Agent tool_use
// events (subagent delegations). Static parity checks run everywhere; the
// live PowerShell e2e runs on Windows only (the production invocation:
// `powershell -File stop.ps1` with the hook JSON piped to stdin).

import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import spawn from "cross-spawn";

const SCRIPTS = join(process.cwd(), "src", "hooks", "scripts");

describe("stop hook delegation scan — script parity", () => {
  it("stop.ps1 scans content blocks for Task/Agent and ships `delegations`", async () => {
    const ps1 = await readFile(join(SCRIPTS, "stop.ps1"), "utf8");
    expect(ps1).toContain('"Task"');
    expect(ps1).toContain('"Agent"');
    expect(ps1).toContain("subagent_type");
    expect(ps1).toContain("delegations");
    expect(ps1).toContain("session_id");
  });

  it("stop.sh mirrors the scan with jq", async () => {
    const sh = await readFile(join(SCRIPTS, "stop.sh"), "utf8");
    expect(sh).toContain('.name == "Task" or .name == "Agent"');
    expect(sh).toContain(".input.subagent_type");
    expect(sh).toContain("delegations:$d");
    expect(sh).toContain("session_id");
  });
});

describe.runIf(process.platform === "win32")("stop.ps1 live e2e (Windows)", () => {
  it("POSTs usage + delegation events parsed from a real transcript window", async () => {
    const proj = await mkdtemp(join(tmpdir(), "syn-stop-e2e-"));
    await mkdir(join(proj, ".synthra-graph"), { recursive: true });

    // Capture server standing in for syn serve.
    const bodies: Record<string, unknown[]> = { "/log": [], "/context-update": [] };
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          bodies[req.url ?? ""]?.push(JSON.parse(raw));
        } catch {
          // ignore
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(join(proj, ".synthra-graph", "mcp_port"), String(port), "utf8");

    // Transcript: one assistant turn with usage + a Task delegation, one user line.
    const transcript = join(proj, "sess-1234.jsonl");
    const assistant = {
      timestamp: "2026-07-15T10:00:00.000Z",
      message: {
        model: "claude-fable-5",
        usage: { input_tokens: 5, output_tokens: 7 },
        content: [
          { type: "text", text: "delegating" },
          {
            type: "tool_use",
            name: "Task",
            input: { subagent_type: "svelte-file-editor", model: "sonnet", prompt: "build it" },
          },
        ],
      },
    };
    const user = { timestamp: "2026-07-15T10:01:00.000Z", message: { content: "hi" } };
    await writeFile(transcript, `${JSON.stringify(assistant)}\n${JSON.stringify(user)}\n`, "utf8");

    // Run the hook exactly as Claude Code does: -File + JSON on stdin, cwd = project.
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(SCRIPTS, "stop.ps1")],
        { cwd: proj, stdio: ["pipe", "ignore", "ignore"] },
      );
      p.on("error", reject);
      p.on("exit", () => resolve());
      p.stdin?.write(JSON.stringify({ transcript_path: transcript }));
      p.stdin?.end();
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(bodies["/log"]).toHaveLength(1);
    const log = bodies["/log"]?.[0] as {
      input_tokens: number;
      output_tokens: number;
      delegations?: unknown;
    };
    expect(log.input_tokens).toBe(5);
    expect(log.output_tokens).toBe(7);
    // PS 5.1 may collapse a single-element array to an object — accept both.
    const dl = Array.isArray(log.delegations) ? log.delegations : [log.delegations];
    expect(dl).toHaveLength(1);
    const d = dl[0] as { ts: string; agent: string; model: string; session_id: string };
    expect(d.agent).toBe("svelte-file-editor");
    expect(d.model).toBe("sonnet");
    expect(d.session_id).toBe("sess-1234");
    expect(d.ts.startsWith("2026-07-15T10:00")).toBe(true);

    expect(bodies["/context-update"]).toHaveLength(1);
  }, 20_000);
});
