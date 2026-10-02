// Stop hook v0.20: the transcript pass also collects Task/Agent tool_use
// events (subagent delegations). Static parity checks run everywhere. The live
// e2e runs each script the way Claude Code does — hook JSON piped to stdin,
// cwd = project: stop.ps1 on Windows, stop.sh wherever bash, jq and curl are.

import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import spawn from "cross-spawn";
import { spawnSync } from "node:child_process";

const SCRIPTS = join(process.cwd(), "src", "hooks", "scripts");

describe("stop hook delegation scan — script parity", () => {
  it("stop.ps1 scans content blocks for Task/Agent and ships `delegations`", async () => {
    const ps1 = await readFile(join(SCRIPTS, "stop.ps1"), "utf8");
    expect(ps1).toContain('"Task"');
    expect(ps1).toContain('"Agent"');
    expect(ps1).toContain("subagent_type");
    expect(ps1).toContain("$blk.input.description");
    expect(ps1).toContain("/nudge");
    expect(ps1).toContain('decision = "block"');
    expect(ps1).toContain("delegations");
    expect(ps1).toContain("session_id");
  });

  it("stop.sh mirrors the scan with jq", async () => {
    const sh = await readFile(join(SCRIPTS, "stop.sh"), "utf8");
    expect(sh).toContain('.name == "Task" or .name == "Agent"');
    expect(sh).toContain(".input.subagent_type");
    expect(sh).toContain(".input.description");
    expect(sh).toContain("/nudge");
    expect(sh).toContain('{decision:"block", reason:$r}');
    expect(sh).toContain("delegations:$d");
    expect(sh).toContain("session_id");
  });
});

const hasTools = (...tools: string[]) =>
  tools.every((t) => spawnSync(t, ["--version"], { stdio: "ignore" }).status === 0);

interface HookRun {
  /** What it POSTed, by route. */
  bodies: Record<string, unknown[]>;
  /** What it printed — what Claude Code reads as the hook's answer. */
  stdout: string;
}

/**
 * Run one stop script against a one-turn transcript and a capture server
 * standing in for `syn serve`. `nudge` is what the server's /nudge answers;
 * `input` is merged into the hook JSON Claude Code would send.
 */
async function runStopHook(
  command: string,
  args: string[],
  opts: {
    nudge?: Record<string, unknown>;
    input?: Record<string, unknown>;
    /** Run from a subfolder, with CLAUDE_PROJECT_DIR naming the project the way
     *  Claude Code does after Claude cd's into it. */
    fromSubfolder?: boolean;
  } = {},
): Promise<HookRun> {
  const proj = await mkdtemp(join(tmpdir(), "syn-stop-e2e-"));
  await mkdir(join(proj, ".synthra-graph"), { recursive: true });

  const bodies: Record<string, unknown[]> = { "/log": [], "/context-update": [], "/nudge": [] };
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
      res.end(req.url === "/nudge" ? JSON.stringify(opts.nudge ?? {}) : "{}");
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
        { type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } },
        {
          type: "tool_use",
          name: "Task",
          input: {
            subagent_type: "svelte-file-editor",
            model: "sonnet",
            description: "Build the card",
            prompt: "build it",
          },
        },
      ],
    },
  };
  const user = { timestamp: "2026-07-15T10:01:00.000Z", message: { content: "hi" } };
  await writeFile(transcript, `${JSON.stringify(assistant)}\n${JSON.stringify(user)}\n`, "utf8");

  // Never inherit the caller's CLAUDE_PROJECT_DIR: run inside Claude Code, it
  // would point the hook at the real project instead of this one.
  const { CLAUDE_PROJECT_DIR: _inherited, ...env } = process.env;
  let cwd = proj;
  if (opts.fromSubfolder) {
    cwd = join(proj, "Website Overhaul", "pages");
    await mkdir(cwd, { recursive: true });
    env.CLAUDE_PROJECT_DIR = proj;
  }

  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    const p = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    p.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    p.on("error", reject);
    p.on("exit", () => resolve());
    p.stdin?.write(JSON.stringify({ transcript_path: transcript, ...opts.input }));
    p.stdin?.end();
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { bodies, stdout };
}

const REASON = "[Synthra memory check - every 10 replies] Save what you learned.";

/** The nudge round trip, for either script. */
async function expectNudge(command: string, args: string[]): Promise<void> {
  // Nothing to say: the hook prints nothing, and Claude stops as usual.
  const quiet = await runStopHook(command, args);
  expect(quiet.stdout.trim()).toBe("");
  // The reply had two tool calls (a Read, the Task delegation): the skill
  // nudge counts both.
  expect(quiet.bodies["/nudge"]).toEqual([{ stop_hook_active: false, tool_calls: 2 }]);

  // A reason: the hook asks Claude Code to keep Claude for one more step.
  const held = await runStopHook(command, args, { nudge: { reason: REASON } });
  expect(JSON.parse(held.stdout.trim())).toEqual({ decision: "block", reason: REASON });

  // Already continuing because of a Stop hook: the server is told so.
  const again = await runStopHook(command, args, { input: { stop_hook_active: true } });
  expect(again.bodies["/nudge"]).toEqual([{ stop_hook_active: true, tool_calls: 2 }]);
}

function expectUsageAndDelegation({ bodies }: HookRun): void {
  expect(bodies["/log"]).toHaveLength(1);
  const log = bodies["/log"]?.[0] as {
    input_tokens: number;
    output_tokens: number;
    read_calls?: number;
    delegations?: unknown;
  };
  expect(log.input_tokens).toBe(5);
  expect(log.output_tokens).toBe(7);
  expect(log.read_calls).toBe(1);
  // PS 5.1 may collapse a single-element array to an object — accept both.
  const dl = Array.isArray(log.delegations) ? log.delegations : [log.delegations];
  expect(dl).toHaveLength(1);
  const d = dl[0] as {
    ts: string;
    agent: string;
    model: string;
    description: string;
    session_id: string;
  };
  expect(d.agent).toBe("svelte-file-editor");
  expect(d.model).toBe("sonnet");
  expect(d.description).toBe("Build the card");
  expect(d.session_id).toBe("sess-1234");
  expect(d.ts.startsWith("2026-07-15T10:00")).toBe(true);

  expect(bodies["/context-update"]).toHaveLength(1);
}

const PS1 = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(SCRIPTS, "stop.ps1")];

describe.runIf(process.platform === "win32")("stop.ps1 live e2e (Windows)", () => {
  it("POSTs usage + delegation events parsed from a real transcript window", async () => {
    expectUsageAndDelegation(await runStopHook("powershell.exe", PS1));
  }, 20_000);

  it("passes a memory nudge on to Claude Code", async () => {
    await expectNudge("powershell.exe", PS1);
  }, 30_000);

  it("still logs when Claude has cd'd into a subfolder", async () => {
    expectUsageAndDelegation(await runStopHook("powershell.exe", PS1, { fromSubfolder: true }));
  }, 20_000);
});

describe.runIf(process.platform !== "win32" && hasTools("bash", "jq", "curl"))(
  "stop.sh live e2e",
  () => {
    it("POSTs usage + delegation events parsed from a real transcript window", async () => {
      expectUsageAndDelegation(await runStopHook("bash", [join(SCRIPTS, "stop.sh")]));
    }, 20_000);

    it("passes a memory nudge on to Claude Code", async () => {
      await expectNudge("bash", [join(SCRIPTS, "stop.sh")]);
    }, 30_000);

    it("still logs when Claude has cd'd into a subfolder", async () => {
      const run = await runStopHook("bash", [join(SCRIPTS, "stop.sh")], { fromSubfolder: true });
      expectUsageAndDelegation(run);
    }, 20_000);
  },
);
