// v0.32 — the server must own its port before it tells the hooks about it.
//
// reserveFreePort() has to release its probe socket for the real listen, and
// another server can take the port in that gap. Nothing used to wait for the
// listen: EADDRINUSE arrived later as an uncaught error, and mcp_port had
// already been written naming a port another project's server now owned — so
// every hook in the project talked to the wrong server. Two `syn` starting at
// once is ordinary: an editor restoring three windows starts three.

import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server/http.js";
import { resolvePaths } from "../src/shared/paths.js";

function occupy(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("startServer binding", () => {
  it("refuses a taken port without writing mcp_port", async () => {
    const { server, port } = await occupy();
    const paths = resolvePaths(await mkdtemp(join(tmpdir(), "syn-bind-")));
    try {
      await expect(startServer(paths, { port, version: "test" })).rejects.toThrow(/in use/);
      // THE point: no port file naming a port that somebody else answers on.
      expect(existsSync(paths.mcpPort)).toBe(false);
    } finally {
      server.close();
    }
  });

  // Several servers starting together — the editor-restores-its-windows case.
  // Each must end up on its own port, with its own mcp_port naming it.
  it("gives servers that start at the same moment a port each", async () => {
    const all = await Promise.all(
      [1, 2, 3, 4].map(async () => {
        const paths = resolvePaths(await mkdtemp(join(tmpdir(), "syn-bind-")));
        return { paths, handle: await startServer(paths, { version: "test" }) };
      }),
    );
    try {
      const ports = all.map((s) => s.handle.port);
      expect(new Set(ports).size).toBe(ports.length);
      for (const { paths, handle } of all) {
        expect(Number((await readFile(paths.mcpPort, "utf8")).trim())).toBe(handle.port);
        const health = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as {
          project_root: string;
        };
        expect(health.project_root).toBe(paths.projectRoot);
      }
    } finally {
      await Promise.all(all.map((s) => s.handle.stop()));
    }
  });
});
