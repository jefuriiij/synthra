// v0.48 (extension 0.39): the health light turned yellow or red for problems a
// restart fixes, and the user had to click Repair. The server now marks those
// checks, the extension restarts Synthra by itself (once per problem set per
// 30 minutes) and says what it fixed, and a restart keeps the port, so open
// Claude chats keep Synthra's tools.

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoctorCheck, markRestartFixes } from "../src/cli/doctor-command.js";
import { startServer } from "../src/server/http.js";
import { reserveFreePort } from "../src/server/port.js";
import { resolvePaths } from "../src/shared/paths.js";
import {
  AUTO_REPAIR_COOLDOWN_MS,
  fixedBy,
  shouldAutoRepair,
  type DoctorCheck as ExtCheck,
} from "../extension/src/logic.js";

const check = (label: string, detail: string, status: DoctorCheck["status"] = "warn") => ({
  status,
  label,
  detail,
});

describe("which problems a restart fixes", () => {
  it("marks port, .mcp.json, hook, policy and missing-map problems", () => {
    const checks = markRestartFixes([
      check("MCP server", "stale port file: nothing is listening on :8081. Run `syn .` here."),
      check("MCP server", "mcp_port is not a port number (abc)."),
      check(
        "MCP registration",
        ".mcp.json points at :8081 but Synthra runs on :8082. Restart Synthra.",
      ),
      check("Hooks", "registered 2× in .claude/settings.local.json. Run `syn .` to repair."),
      check("CLAUDE.md policy", "policy block is v9, current is v12, re-run `syn .` to refresh."),
      check("Graph", "no info_graph.json, run `syn .` (or `syn scan`) here."),
    ]);
    expect(checks.every((c) => c.fix === "restart")).toBe(true);
  });

  it("leaves what needs the user alone", () => {
    const checks = markRestartFixes([
      check("Hooks", "settings.local.json is not valid JSON, hook state unknown."),
      check("Graph", "0 symbols · 0 files · 0 symbols, unsupported language or nothing indexed"),
      check(
        "Claude connection",
        "Claude has worked here but never connected. Start a new Claude session.",
      ),
      check("Claude Code policy", "a managed setting blocks Synthra's MCP server"),
      check("claude CLI", "'claude' not found"),
      check("Hooks", "3 hooks registered", "ok"),
    ]);
    expect(checks.some((c) => c.fix)).toBe(false);
  });
});

describe("deciding to repair by itself", () => {
  const port: ExtCheck = { status: "fail", label: "MCP server", detail: "x", fix: "restart" };
  const claude: ExtCheck = { status: "warn", label: "Claude connection", detail: "y" };
  const now = 1_000_000_000;

  it("repairs problems a restart fixes, and only those", () => {
    const d = shouldAutoRepair({ checks: [port, claude], enabled: true, last: undefined, now });
    expect(d).toMatchObject({ repair: true, problems: [port] });
    expect(shouldAutoRepair({ checks: [claude], enabled: true, last: undefined, now }).repair).toBe(
      false,
    );
  });

  it("never loops: the same problems wait out the cooldown, new ones don't", () => {
    const first = shouldAutoRepair({ checks: [port], enabled: true, last: undefined, now });
    if (!first.repair) throw new Error("expected a repair");
    const last = { signature: first.signature, at: now };
    expect(
      shouldAutoRepair({ checks: [port], enabled: true, last, now: now + 60_000 }).repair,
    ).toBe(false);
    expect(
      shouldAutoRepair({
        checks: [port],
        enabled: true,
        last,
        now: now + AUTO_REPAIR_COOLDOWN_MS + 1,
      }).repair,
    ).toBe(true);
    const hooks: ExtCheck = { status: "warn", label: "Hooks", detail: "z", fix: "restart" };
    expect(
      shouldAutoRepair({ checks: [hooks], enabled: true, last, now: now + 60_000 }).repair,
    ).toBe(true);
  });

  it("does nothing when switched off, or on an older Synthra without the mark", () => {
    expect(shouldAutoRepair({ checks: [port], enabled: false, last: undefined, now }).repair).toBe(
      false,
    );
    const old: ExtCheck = { status: "fail", label: "MCP server", detail: "x" };
    expect(shouldAutoRepair({ checks: [old], enabled: true, last: undefined, now }).repair).toBe(
      false,
    );
  });

  it("says which problems the restart fixed", () => {
    const hooks: ExtCheck = { status: "warn", label: "Hooks", detail: "z", fix: "restart" };
    const after: ExtCheck[] = [
      { status: "ok", label: "MCP server", detail: "ok" },
      { status: "warn", label: "Hooks", detail: "z", fix: "restart" },
    ];
    expect(fixedBy([port, hooks], after).map((c) => c.label)).toEqual(["MCP server"]);
  });
});

describe("a restart keeps its port", () => {
  it("tries the preferred port first", async () => {
    const a = await reserveFreePort(8090, 8099);
    const port = a.port;
    await a.release();
    const b = await reserveFreePort(8080, 8099, port);
    expect(b.port).toBe(port);
    await b.release();
  });

  it("starts on the port it had last time", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-lastport-"));
    const paths = resolvePaths(root);
    const probe = await reserveFreePort(8090, 8099);
    const wanted = probe.port;
    await probe.release();
    const first = await startServer(paths, { version: "t" });
    await first.stop();
    await writeFile(paths.lastPort, String(wanted));
    const second = await startServer(paths, { version: "t" });
    try {
      expect(second.port).toBe(wanted);
      expect((await readFile(paths.lastPort, "utf8")).trim()).toBe(String(wanted));
    } finally {
      await second.stop();
    }
  }, 30_000);
});
