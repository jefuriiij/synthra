// v0.51. Synthra's MCP server took a port another app was using. It listens
// on 127.0.0.1, and on Windows that bind works while another program holds
// the same port on 0.0.0.0, "::" or "::1". Both then listen, and localhost
// goes to Synthra: a backend on 0.0.0.0:8080 had its sign-in answered by
// Synthra's "cross-origin request refused". Now Synthra asks whether anything
// answers before it takes a port, keeps away from the common dev ports, and
// names itself in every refusal.

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLocalJsonPost } from "../src/dashboard/origin-guard.js";
import { startServer } from "../src/server/http.js";
import { PORT_RANGE_END, PORT_RANGE_START, answers, reserveFreePort } from "../src/server/port.js";
import { resolvePaths } from "../src/shared/paths.js";

/** Another app's server on `host`, or null when this machine can't (no IPv6). */
function otherApp(port: number, host: string): Promise<Server | null> {
  return new Promise((resolve) => {
    const s = createServer((c) => {
      c.on("error", () => {});
      c.destroy();
    });
    s.once("error", () => resolve(null));
    s.once("listening", () => resolve(s));
    s.listen({ port, host });
  });
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

/** Four ports in a row that are free right now, well away from Synthra's. */
async function freeRun(): Promise<number> {
  for (let tries = 0; tries < 20; tries++) {
    const base = 30000 + Math.floor(Math.random() * 15000);
    const held: Server[] = [];
    for (let p = base; p < base + 4; p++) {
      const s = await otherApp(p, "127.0.0.1");
      if (!s) break;
      held.push(s);
    }
    await Promise.all(held.map(close));
    if (held.length === 4) return base;
  }
  throw new Error("no four free ports in a row");
}

describe("the default range keeps away from dev servers", () => {
  it("is 47080 to 47099: not 8080, and below the ports the OS hands out", () => {
    expect([PORT_RANGE_START, PORT_RANGE_END]).toEqual([47080, 47099]);
    expect(PORT_RANGE_END).toBeLessThan(49152);
  });
});

describe("a port another app serves is not taken", () => {
  it("sees nothing on a free port", async () => {
    const base = await freeRun();
    expect(await answers(base)).toBe(false);
  });

  // Each address a dev server may listen on. On Windows a bind to 127.0.0.1
  // works beside the first three, so only a connect tells.
  for (const host of ["0.0.0.0", "::", "::1", "127.0.0.1"]) {
    it(`skips a port with an app on ${host}`, async (ctx) => {
      const base = await freeRun();
      const other = await otherApp(base, host);
      if (!other) return ctx.skip(); // no IPv6 here
      try {
        expect(await answers(base)).toBe(true);
        const r = await reserveFreePort(base, base + 3);
        await r.release();
        expect(r.port).toBe(base + 1);
        // Also when it is the port this project had last time.
        const again = await reserveFreePort(base, base + 3, base);
        await again.release();
        expect(again.port).toBe(base + 1);
      } finally {
        await close(other);
      }
    });
  }

  it("refuses a pinned port (SYN_MCP_PORT) another app serves", async () => {
    const base = await freeRun();
    const other = await otherApp(base, "0.0.0.0");
    if (!other) throw new Error("could not start the other app");
    const dir = await mkdtemp(join(tmpdir(), "syn-port-pin-"));
    try {
      await expect(startServer(resolvePaths(dir), { version: "test", port: base })).rejects.toThrow(
        /already in use by another program/,
      );
    } finally {
      await close(other);
    }
  });
});

describe("a refusal says who answered", () => {
  it("names Synthra and its port in the cross-origin and content-type refusals", () => {
    const cross = checkLocalJsonPost("application/json", "http://localhost:5173", 47080);
    expect(cross).toMatchObject({ ok: false, status: 403 });
    expect(cross.ok ? "" : cross.error).toMatch(
      /^cross-origin request refused\. This is Synthra's local server on port 47080, not your app\./,
    );
    const type = checkLocalJsonPost("text/plain", undefined, 47080);
    expect(type.ok ? "" : type.error).toContain("Synthra's local server on port 47080");
    expect(checkLocalJsonPost("application/json", undefined, 47080)).toEqual({ ok: true });
  });

  it("names Synthra for a path it doesn't have, such as another app's /api", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-port-404-"));
    const handle = await startServer(resolvePaths(dir), { version: "test" });
    try {
      expect(handle.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(handle.port).toBeLessThanOrEqual(PORT_RANGE_END);
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/auth/session`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(`Synthra's local server on port ${handle.port}, not your app`);
      expect(body.error).toContain("/api/auth/session");
      // The request an app's own sign-in form sends.
      const post = await fetch(`http://127.0.0.1:${handle.port}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: "{}",
      });
      expect(post.status).toBe(403);
      expect(((await post.json()) as { error: string }).error).toContain("Synthra's local server");
    } finally {
      await handle.stop();
    }
  });
});
