// HTTP server (Hono). Hosts the routes hooks need (/prime, /pack, /log,
// /gate, /activity) and serves the loaded graph from memory. The MCP-protocol
// envelope (/mcp endpoint, JSON-RPC) is wired in M3.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { writeFile } from "node:fs/promises";

import { ActivityStore } from "../activity/activity-log.js";
import { createFileWatcher, type FileWatcher } from "../activity/file-watcher.js";
import { createGitWatcher, type GitWatcher } from "../activity/git-watcher.js";
import { scanProject } from "../cli/scan-command.js";
import { readGraph, readSymbolIndex } from "../graph/store.js";
import { SCHEMA_VERSION } from "../graph/types.js";
import { LearnRuntime } from "../learn/runtime.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import type { ServerContext } from "./context.js";
import { handleMcpRequest } from "./mcp.js";
import { findFreePort } from "./port.js";
import { type Reindexer, createReindexer, rescanAndSwap } from "./reindex.js";
import { handleActivity } from "./routes/activity.js";
import { handleContextUpdate } from "./routes/context-update.js";
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
    let [graph, symbolIndex] = await Promise.all([
      readGraph(paths.infoGraph),
      readSymbolIndex(paths.symbolIndex),
    ]);
    // Schema-migration check (#8): a graph written by an older Synthra may have
    // an incompatible on-disk shape. On a version mismatch, auto-rescan once and
    // reload, rather than serving a stale/incompatible graph.
    if (graph.schema_version !== SCHEMA_VERSION) {
      log.info(`graph schema v${graph.schema_version} ≠ current v${SCHEMA_VERSION} — rescanning…`);
      await scanProject(paths.projectRoot, { silent: true });
      [graph, symbolIndex] = await Promise.all([
        readGraph(paths.infoGraph),
        readSymbolIndex(paths.symbolIndex),
      ]);
    }
    const activity = new ActivityStore(paths.activityLog);
    // Usage-learning runtime: loads the decayed aggregate (replaying the raw
    // access log if the aggregate is cold). Best-effort — never blocks startup.
    const learn = await LearnRuntime.load(paths.accessLog, paths.learnStore);
    return { paths, graph, symbolIndex, activity, learn };
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
    return c.json(await handleActivity(Number.isFinite(sinceMs) ? sinceMs : undefined, ctx));
  });

  app.post("/context-update", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await handleContextUpdate(body, ctx));
  });

  app.post("/mcp", async (c) => {
    const body = await c.req.json().catch(() => null);
    return c.json(await handleMcpRequest(body, ctx));
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

  // Auto-reindex: a source edit re-runs the incremental scan + swaps the
  // in-memory graph so reads never go stale mid-session (debounced; opt out with
  // SYN_NO_AUTOREINDEX). The watcher already ignores .synthra-graph/, so a scan's
  // own writes can't loop back.
  const cfg = loadConfig();
  const reindexer: Reindexer | null = cfg.autoReindex
    ? createReindexer(ctx, paths, { debounceMs: cfg.reindexDebounceMs })
    : null;

  // Spin up the human-activity watchers. Both are best-effort — if chokidar
  // can't watch (e.g. unsupported FS) or .git is missing, they no-op silently.
  const fileWatcher: FileWatcher = createFileWatcher(paths.projectRoot, (e) => {
    void ctx.activity.add(e);
    reindexer?.schedule();
  });
  const gitWatcher: GitWatcher = createGitWatcher(paths.projectRoot, async (e) => {
    await ctx.activity.add(e);
    // Per-branch graph: rebuild on branch switch so the in-memory graph
    // matches whichever branch is currently checked out.
    if (e.kind === "branch-switch") {
      const to = (e.details as { to?: string } | undefined)?.to ?? "unknown";
      await rescanAndSwap(ctx, paths, `branch ${to}`);
    }
  });
  try {
    await fileWatcher.start();
  } catch (err) {
    log.warn(`file watcher failed to start: ${(err as Error).message}`);
  }
  try {
    await gitWatcher.start();
  } catch (err) {
    log.warn(`git watcher failed to start: ${(err as Error).message}`);
  }

  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    async stop() {
      reindexer?.stop();
      await fileWatcher.stop().catch(() => undefined);
      await gitWatcher.stop().catch(() => undefined);
      // Persist any pending usage signal before we go down.
      await ctx.learn?.flush().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
