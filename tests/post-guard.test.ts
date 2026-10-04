// The MCP server refuses any POST a web page could send: a page on any site
// can fire a no-cors text/plain POST at 127.0.0.1, so every POST must be
// application/json with no foreign Origin. Without this, a page could turn
// skill approval off through /settings and plant a skill through /mcp.

import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server/http.js";
import { resolvePaths } from "../src/shared/paths.js";

async function withServer(fn: (base: string, port: number) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "syn-post-guard-"));
  const handle = await startServer(resolvePaths(dir), { version: "test" });
  try {
    await fn(`http://127.0.0.1:${handle.port}`, handle.port);
  } finally {
    await handle.stop();
  }
}

const body = JSON.stringify({ key: "skillApproval", value: false });

describe("POST guard", () => {
  it("refuses a text/plain POST (what a no-cors page sends)", async () => {
    await withServer(async (base) => {
      for (const route of [
        "/settings",
        "/mcp",
        "/skills/approve",
        "/skills/delete",
        "/skills/answer-group",
        "/restore",
        "/skills/updates/check",
        "/skills/hold",
        "/skills/update-command",
        "/curator/run",
        "/gate",
      ]) {
        const r = await fetch(`${base}${route}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        });
        expect(r.status, route).toBe(415);
      }
    });
  });

  it("refuses a JSON POST from a foreign Origin", async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body,
      });
      expect(r.status).toBe(403);
    });
  });

  it("lets the hooks, the extension and Claude Code through: JSON, no browser Origin", async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(r.status).toBe(200);
      // Reads are untouched.
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });
  });

  it("accepts its own origin", async () => {
    await withServer(async (base, port) => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(r.status).toBe(200);
    });
  });
});
