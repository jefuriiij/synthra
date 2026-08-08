// v0.26 — one owner per project.
//
// Before this, nothing in Synthra knew who owned a project: a second `syn` bound
// another port, overwrote mcp_port, and orphaned the first server (still
// watching files, still writing state) while every hook talked to whoever wrote
// the port file last. And since nothing ever removed mcp_port, a clean exit left
// a file naming a dead port — which makes all ten hook scripts no-op *silently*.

import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRegisteredPort, unregisterMcp } from "../src/cli/start-claude.js";
import {
  checkOwner,
  claimOwnership,
  probeHealth,
  releaseOwnership,
  sameRoot,
} from "../src/server/owner.js";
import { reserveFreePort } from "../src/server/port.js";
import { resolvePaths } from "../src/shared/paths.js";

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syn-own-"));
  await mkdir(join(dir, ".synthra-graph"), { recursive: true });
  return dir;
}

/** A stand-in Synthra server: answers /health as `servedRoot`'s owner. */
async function fakeServer(servedRoot: string | null): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((req, res) => {
    if (req.url !== "/health" || servedRoot === null) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, project_root: servedRoot, pid: 4242, port: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => server.close() };
}

describe("probeHealth", () => {
  it("returns the identity a Synthra server reports", async () => {
    const s = await fakeServer("C:/work/alpha");
    try {
      expect((await probeHealth(s.port))?.project_root).toBe("C:/work/alpha");
    } finally {
      s.close();
    }
  });

  it("returns null when nothing is listening", async () => {
    // Reserve then release: nothing holds it, so the probe must fail fast.
    const r = await reserveFreePort();
    await r.release();
    expect(await probeHealth(r.port, 400)).toBeNull();
  });

  it("returns null for a non-Synthra server on the port", async () => {
    // Ports are machine-global — anything at all can be sitting there.
    const s = await fakeServer(null);
    try {
      expect(await probeHealth(s.port, 400)).toBeNull();
    } finally {
      s.close();
    }
  });
});

describe("checkOwner", () => {
  it("reports 'none' with no owner record", async () => {
    const dir = await project();
    expect((await checkOwner(resolvePaths(dir))).state).toBe("none");
  });

  it("reports 'live' when the recorded port serves THIS project", async () => {
    const dir = await project();
    const paths = resolvePaths(dir);
    const s = await fakeServer(dir);
    try {
      await claimOwnership(paths, s.port, "0.26.0");
      const owner = await checkOwner(paths);
      expect(owner.state).toBe("live");
      if (owner.state === "live") expect(owner.record.port).toBe(s.port);
    } finally {
      s.close();
    }
  });

  it("reports 'stale' when nobody answers the recorded port", async () => {
    const dir = await project();
    const paths = resolvePaths(dir);
    const r = await reserveFreePort();
    await r.release(); // record a port that is now dead
    await claimOwnership(paths, r.port, "0.26.0");

    const owner = await checkOwner(paths);
    expect(owner.state).toBe("stale");
  });

  it("reports 'foreign' when the recorded port now serves a DIFFERENT project", async () => {
    // The dangerous case: ports are recycled, so this project's hooks would be
    // reading and writing another project's state via a stale port file.
    const dir = await project();
    const paths = resolvePaths(dir);
    const neighbour = await fakeServer("C:/work/somebody-else");
    try {
      await claimOwnership(paths, neighbour.port, "0.26.0");
      const owner = await checkOwner(paths);
      expect(owner.state).toBe("foreign");
      if (owner.state === "foreign") expect(owner.servedRoot).toBe("C:/work/somebody-else");
    } finally {
      neighbour.close();
    }
  });
});

describe("claimOwnership / releaseOwnership", () => {
  it("writes mcp_port as a bare integer the hook scripts can parse", async () => {
    // Every hook reads this with (Get-Content).Trim() / cat|tr -d, and hooks are
    // only rewritten on `syn .` — so this shape can never gain JSON.
    const dir = await project();
    const paths = resolvePaths(dir);
    await claimOwnership(paths, 8087, "0.26.0");
    expect((await readFile(paths.mcpPort, "utf8")).trim()).toBe("8087");
  });

  it("removes both files on release", async () => {
    const dir = await project();
    const paths = resolvePaths(dir);
    await claimOwnership(paths, 8087, "0.26.0");
    await releaseOwnership(paths);

    expect(await exists(paths.mcpPort)).toBe(false);
    expect(await exists(paths.mcpOwner)).toBe(false);
  });

  it("leaves another process's record alone", async () => {
    // Our exit must never disarm a server that took over after us.
    const dir = await project();
    const paths = resolvePaths(dir);
    await writeFile(
      paths.mcpOwner,
      JSON.stringify({
        port: 8090,
        pid: process.pid + 10_000,
        projectRoot: dir,
        startedAt: new Date().toISOString(),
        version: "0.26.0",
      }),
      "utf8",
    );
    await writeFile(paths.mcpPort, "8090", "utf8");

    await releaseOwnership(paths);
    expect(await exists(paths.mcpOwner)).toBe(true);
    expect((await readFile(paths.mcpPort, "utf8")).trim()).toBe("8090");
  });
});

describe("reserveFreePort", () => {
  it("holds the port so a second caller can't pick the same one", async () => {
    // findFreePort used to bind, close, then return — leaving a window where two
    // servers starting together both chose the same port.
    const a = await reserveFreePort();
    const b = await reserveFreePort();
    try {
      expect(b.port).not.toBe(a.port);
    } finally {
      await a.release();
      await b.release();
    }
  });
});

describe("unregisterMcp", () => {
  // `--scope project` is ONE shared entry in .mcp.json, not one per process.
  // Removing it unconditionally on shutdown is what dropped a live server's
  // registration mid-session with both `claude mcp` calls exiting 0.
  const writeReg = (dir: string, port: number) =>
    writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { synthra: { type: "http", url: `http://127.0.0.1:${port}/mcp` } },
      }),
      "utf8",
    );

  it("reads the registered port out of .mcp.json", async () => {
    const dir = await project();
    await writeReg(dir, 8083);
    expect(await readRegisteredPort(dir)).toBe(8083);
  });

  it("returns null when there is no registration", async () => {
    expect(await readRegisteredPort(await project())).toBeNull();
  });

  it("does nothing when the registration points at someone else's port", async () => {
    const dir = await project();
    await writeReg(dir, 9999);
    // A bogus bin would fail loudly if we got as far as spawning it; the point
    // is that the port check returns first and .mcp.json survives untouched.
    await unregisterMcp("definitely-not-a-real-binary", dir, 8083);
    expect(await readRegisteredPort(dir)).toBe(9999);
  });
});

describe("sameRoot", () => {
  it("ignores slash direction, trailing slashes and drive-letter case", async () => {
    expect(sameRoot("C:\\work\\app", "c:/work/app")).toBe(true);
    expect(sameRoot("C:/work/app/", "C:/work/app")).toBe(true);
    expect(sameRoot("C:/work/app", "C:/work/other")).toBe(false);
  });
});
