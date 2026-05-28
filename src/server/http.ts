// HTTP server (Hono). Hosts the routes hooks need (/prime, /pack, /log,
// /gate, /activity) and serves the loaded graph from memory. The MCP-protocol
// envelope (/mcp endpoint, JSON-RPC) is wired in M3.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { writeFile } from "node:fs/promises";

import { readGraph, readSymbolIndex } from "../graph/store.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import type { ServerContext } from "./context.js";
import { findFreePort } from "./port.js";
import { handleActivity } from "./routes/activity.js";
import { handleGate } from "./routes/gate.js";
import { handleLog } from "./routes/log.js";
import { handlePack } from "./routes/pack.js";
import { handlePrime } from "./routes/prime.js";

export interface ServerHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Override the port range search. */
  port?: number;
}

async function loadContext(paths: SynthraPaths): Promise<ServerContext> {
  try {
    const [graph, symbolIndex] = await Promise.all([
      readGraph(paths.infoGraph),
      readSymbolIndex(paths.symbolIndex),
    ]);
    return { paths, graph, symbolIndex };
  } catch (err) {
    throw new Error(
      `failed to load graph from ${paths.infoGraph}: ${(err as Error).message}. ` +
        `Run \`syn scan\` first.`,
    );
  }
}

function buildApp(ctx: ServerContext, port: number): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      service: "synthra",
      version: "0.0.1",
      port,
      file_count: ctx.graph.file_count,
      symbol_count: ctx.graph.symbol_count,
      generated_at: ctx.graph.generated_at,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/prime", async (c) => c.json(await handlePrime(ctx, port)));

  app.post("/pack", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await handlePack(body, ctx));
  });

  app.post("/log", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await handleLog(body, ctx));
  });

  app.post("/gate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await handleGate(body, ctx));
  });

  app.get("/activity", async (c) => {
    const sinceParam = c.req.query("since");
    const sinceMs = sinceParam ? Number(sinceParam) : undefined;
    return c.json(
      await handleActivity(Number.isFinite(sinceMs) ? sinceMs : undefined, ctx),
    );
  });

  app.onError((err, c) => {
    log.error("route error:", err.message);
    return c.json({ error: err.message }, 400);
  });

  return app;
}

export async function startServer(
  paths: SynthraPaths,
  options: StartOptions = {},
): Promise<ServerHandle> {
  const ctx = await loadContext(paths);
  const port = options.port ?? (await findFreePort());

  const app = buildApp(ctx, port);
  const nodeServer = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

  await writeFile(paths.mcpPort, String(port), "utf8");

  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
