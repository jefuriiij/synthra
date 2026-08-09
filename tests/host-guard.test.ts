// v0.27 — DNS rebinding defence.
//
// Both Hono apps bind 127.0.0.1 with no auth, which is not the boundary it
// feels like: a page in the user's browser will make localhost requests on an
// attacker's behalf if the attacker re-points their own domain at 127.0.0.1.
// The browser then treats the request as same-origin — no CORS, response
// readable — so Origin can't catch it. Host can, because page script is
// forbidden from setting it.

import { describe, it, expect } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server/http.js";
import { forbiddenHostMessage, isAllowedHost } from "../src/shared/host-guard.js";
import { resolvePaths } from "../src/shared/paths.js";

const PORT = 8901;

describe("isAllowedHost — loopback", () => {
  it("accepts the loopback names on our own port", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(isAllowedHost(`${host}:${PORT}`, PORT)).toBe(true);
    }
  });

  it("is case-insensitive about the hostname", () => {
    expect(isAllowedHost(`LocalHost:${PORT}`, PORT)).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isAllowedHost(`  127.0.0.1:${PORT}  `, PORT)).toBe(true);
  });

  it("refuses a loopback name on a port we don't hold", () => {
    // Ports are machine-global; answering for one we don't own is the same
    // class of mistake v0.26 fixed for mcp_port.
    expect(isAllowedHost("127.0.0.1:9999", PORT)).toBe(false);
  });

  it("refuses a loopback name with no port at all", () => {
    expect(isAllowedHost("127.0.0.1", PORT)).toBe(false);
  });
});

describe("isAllowedHost — the attack it exists to stop", () => {
  it("refuses a rebound attacker domain on our port", () => {
    // This is the exact shape of a DNS-rebinding request: the browser dialled
    // attacker.example, which now resolves to 127.0.0.1, so it lands here —
    // but Host still names the attacker, and script cannot change that.
    expect(isAllowedHost(`attacker.example:${PORT}`, PORT)).toBe(false);
  });

  it("refuses a hostname that merely contains a loopback name", () => {
    expect(isAllowedHost(`localhost.attacker.example:${PORT}`, PORT)).toBe(false);
    expect(isAllowedHost(`127.0.0.1.attacker.example:${PORT}`, PORT)).toBe(false);
    expect(isAllowedHost(`notlocalhost:${PORT}`, PORT)).toBe(false);
  });

  it("fails closed on a missing or empty Host", () => {
    // HTTP/1.1 requires Host and node maps HTTP/2's :authority onto it, so an
    // absent one means a hand-rolled client, not a browser or a hook script.
    expect(isAllowedHost(undefined, PORT)).toBe(false);
    expect(isAllowedHost("", PORT)).toBe(false);
    expect(isAllowedHost("   ", PORT)).toBe(false);
  });

  it("does not treat a port-only string as loopback", () => {
    expect(isAllowedHost(`:${PORT}`, PORT)).toBe(false);
  });
});

describe("isAllowedHost — SYN_ALLOWED_HOSTS", () => {
  it("accepts a listed hostname on any port when no port is pinned", () => {
    // So someone tunnelling doesn't have to enumerate 8080-8099.
    expect(isAllowedHost("dev.box:8901", PORT, ["dev.box"])).toBe(true);
    expect(isAllowedHost("dev.box:1234", PORT, ["dev.box"])).toBe(true);
    expect(isAllowedHost("dev.box", PORT, ["dev.box"])).toBe(true);
  });

  it("honours a pinned port when the entry names one", () => {
    expect(isAllowedHost("dev.box:8901", PORT, ["dev.box:8901"])).toBe(true);
    expect(isAllowedHost("dev.box:1234", PORT, ["dev.box:8901"])).toBe(false);
  });

  it("still refuses anything not on the list", () => {
    expect(isAllowedHost(`attacker.example:${PORT}`, PORT, ["dev.box"])).toBe(false);
  });

  it("matches a listed entry case-insensitively", () => {
    expect(isAllowedHost("DEV.box:8901", PORT, ["dev.BOX"])).toBe(true);
  });

  it("an empty list changes nothing", () => {
    expect(isAllowedHost(`127.0.0.1:${PORT}`, PORT, [])).toBe(true);
    expect(isAllowedHost(`dev.box:${PORT}`, PORT, [])).toBe(false);
  });
});

describe("isAllowedHost — IPv6 parsing", () => {
  it("does not mistake an IPv6 literal's colons for a port separator", () => {
    // A bare literal has no port; only the bracketed form can carry one.
    expect(isAllowedHost("[::1]:8901", PORT)).toBe(true);
    expect(isAllowedHost("[::1]:9999", PORT)).toBe(false);
    expect(isAllowedHost("::1", PORT)).toBe(false); // no port -> not ours
  });

  it("refuses a malformed bracketed host rather than guessing", () => {
    expect(isAllowedHost("[::1:8901", PORT)).toBe(false);
  });
});

// The unit tests above prove the predicate. This proves it is actually wired
// in front of every route on a real server — the failure mode being a guard
// that exists but was never registered, or registered after the routes.
describe("live server refuses a rebound Host", () => {
  /** node:http, not fetch — undici forbids setting Host, which is the whole
   *  point of the header, so it can't express the attack. */
  function request(port: number, path: string, host: string, method = "GET") {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port, path, method, headers: { Host: host } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("serves localhost and refuses an attacker's domain on the same port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-hostguard-"));
    const handle = await startServer(resolvePaths(dir), { version: "test" });
    try {
      const ok = await request(handle.port, "/health", `127.0.0.1:${handle.port}`);
      expect(ok.status).toBe(200);

      // Exactly what a rebound request looks like: it reached 127.0.0.1, but
      // Host still names the domain the browser was told to dial.
      const rebound = await request(handle.port, "/health", `attacker.example:${handle.port}`);
      expect(rebound.status).toBe(403);
      expect(rebound.body).toContain("SYN_ALLOWED_HOSTS");

      // /mcp is the one that matters — graph_read reads any project file.
      const mcp = await request(handle.port, "/mcp", `attacker.example:${handle.port}`, "POST");
      expect(mcp.status).toBe(403);
    } finally {
      await handle.stop();
    }
  });
});

describe("forbiddenHostMessage", () => {
  it("names the offending host and the escape hatch", () => {
    const msg = forbiddenHostMessage("attacker.example:8901");
    expect(msg).toContain("attacker.example:8901");
    expect(msg).toContain("SYN_ALLOWED_HOSTS");
  });

  it("says so plainly when there was no Host at all", () => {
    expect(forbiddenHostMessage(undefined)).toContain("no Host header");
  });
});
