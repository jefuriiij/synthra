// HTTP server (Hono). Hosts the routes hooks need (/prime, /pack, /log,
// /gate, /activity) and serves the loaded graph from memory. The MCP-protocol
// envelope (/mcp endpoint, JSON-RPC) is wired in M3.

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { ActivityStore } from "../activity/activity-log.js";
import { createFileWatcher, type FileWatcher } from "../activity/file-watcher.js";
import { createGitWatcher, type GitWatcher } from "../activity/git-watcher.js";
import { runDoctorChecks, worstStatus } from "../cli/doctor-command.js";
import { scanProject } from "../cli/scan-command.js";
import { readGraph, readSymbolIndex } from "../graph/store.js";
import { SCHEMA_VERSION } from "../graph/types.js";
import { LearnRuntime } from "../learn/runtime.js";
import { loadConfig } from "../shared/config.js";
import { forbiddenHostMessage, isAllowedHost } from "../shared/host-guard.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import type { ServerContext } from "./context.js";
import { handleMcpRequest } from "./mcp.js";
import { checkOwner, claimOwnership, releaseOwnership } from "./owner.js";
import { reserveFreePort, type PortReservation } from "./port.js";
import { type Reindexer, createReindexer, rescanAndSwap } from "./reindex.js";
import { handleActivity } from "./routes/activity.js";
import { handleContextUpdate } from "./routes/context-update.js";
import { handleGate } from "./routes/gate.js";
import { handleLog } from "./routes/log.js";
import { handlePack } from "./routes/pack.js";
import { handlePrime } from "./routes/prime.js";
import { handleRoute } from "./routes/route.js";

export interface ServerHandle {
  port: number;
  url: string;
  /** True when a live server already owned this project and we deferred to it
   *  (v0.26). The caller must NOT re-register MCP or treat this as its own. */
  alreadyRunning?: boolean;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Override the port range search. */
  port?: number;
  /** Recorded in the owner file for diagnostics. */
  version?: string;
}

async function loadContext(paths: SynthraPaths): Promise<ServerContext> {
  try {
    let [graph, symbolIndex] = await Promise.all([
      readGraph(paths.infoGraph),
      readSymbolIndex(paths.symbolIndex),
    ]);

    // Rescan when the graph can't be used as-is. Three causes, one remedy:
    // it isn't there, it's damaged (already quarantined by the reader), or it
    // was written by an older Synthra with an incompatible shape. The graph is
    // derived from the filesystem, so rebuilding costs time and loses nothing —
    // far better than the fatal "Run `syn scan` first" this used to throw, which
    // refused to start over a file we could regenerate ourselves.
    const why =
      graph === null || symbolIndex === null
        ? "graph missing or unreadable"
        : graph.schema_version !== SCHEMA_VERSION
          ? `graph schema v${graph.schema_version} ≠ current v${SCHEMA_VERSION}`
          : null;

    if (why) {
      log.info(`${why} — rescanning…`);
      await scanProject(paths.projectRoot, { silent: true });
      [graph, symbolIndex] = await Promise.all([
        readGraph(paths.infoGraph),
        readSymbolIndex(paths.symbolIndex),
      ]);
    }

    if (graph === null || symbolIndex === null) {
      // A fresh scan still didn't produce a readable graph — that's a real
      // failure worth stopping for, not something a retry fixes.
      throw new Error(`graph at ${paths.infoGraph} is unreadable after a rescan`);
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

function buildApp(ctx: ServerContext, port: number, version: string): Hono {
  const app = new Hono();

  // First, and on every route rather than per-handler — a guard you have to
  // remember to add is a guard that gets missed on the next route. This one
  // matters most here: /mcp exposes graph_read, which reads any file in the
  // project, to anyone who can get a request through.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (!isAllowedHost(host, port, loadConfig().allowedHosts)) {
      log.warn(`refused request with Host: ${host ?? "(none)"}`);
      return c.json({ error: forbiddenHostMessage(host) }, 403);
    }
    await next();
  });

  app.get("/", (c) =>
    c.json({
      service: "synthra",
      version,
      port,
      file_count: ctx.graph.file_count,
      symbol_count: ctx.graph.symbol_count,
      generated_at: ctx.graph.generated_at,
    }),
  );

  // Liveness AND identity. Ports are machine-global and mcp_port outlives the
  // process that wrote it, so "something answered" is not the same as "our
  // server answered" — a stale port file can name a port another project's
  // Synthra now owns. Callers compare project_root before trusting it.
  app.get("/health", (c) =>
    c.json({ ok: true, project_root: ctx.paths.projectRoot, pid: process.pid, port }),
  );

  // `syn doctor`, served live — the IDE extension polls this to drive its
  // status-bar health light. Every serious Synthra failure so far has been
  // silent (hooks registered seven times, a dead port file no-oping every hook,
  // CRLF hook scripts), and doctor could see most of them; nobody runs doctor
  // without a reason. `?env=1` adds the checks that spawn processes (Node, jq,
  // `claude --version`) — the extension asks for those once, not per poll.
  // `version` is the version of THIS server process, which is not necessarily
  // what's installed: another window may have upgraded the package since.
  app.get("/doctor", async (c) => {
    const checks = await runDoctorChecks(ctx.paths.projectRoot, {
      environment: c.req.query("env") === "1",
      selfPort: port,
    });
    return c.json({ version, status: worstStatus(checks), checks });
  });

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

  // The Dispatcher: the UserPromptSubmit hook posts each prompt; a non-empty
  // hint is injected into the conversation as added context.
  app.post("/route", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await handleRoute(body, ctx));
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

/** How many ports to try when another server wins the race for the one we
 *  picked. Each loss means someone else just bound it, so the next free port is
 *  a fresh draw; a handful covers several editor windows restoring at once. */
const BIND_ATTEMPTS = 5;

type NodeServer = ReturnType<typeof serve>;

/** Resolves once the server is really listening; false if the bind failed
 *  because the port was taken, and rethrows anything else. */
function awaitListening(server: NodeServer): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

/**
 * Bind the HTTP server, and don't return until the port is genuinely ours.
 *
 * reserveFreePort() holds the probe socket, but it has to release it for the
 * real listen, and in that gap another server can take the port. Two `syn`
 * starting at the same moment is ordinary — an editor restoring three windows
 * starts three. Previously nothing waited for the listen: the EADDRINUSE landed
 * later as an uncaught error, and mcp_port had ALREADY been written naming a
 * port that another project's server now owned — so every hook in this project
 * quietly talked to the wrong server. Now a lost race just means the next port.
 */
async function bindServer(
  ctx: ServerContext,
  version: string,
  explicitPort: number | undefined,
): Promise<{ port: number; nodeServer: NodeServer }> {
  const attempts = explicitPort ? 1 : BIND_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let port: number;
    if (explicitPort) {
      port = explicitPort;
    } else {
      const reservation: PortReservation = await reserveFreePort();
      port = reservation.port;
      await reservation.release();
    }
    // The app is per-port: the Host guard only accepts requests for the port it
    // was built for.
    const app = buildApp(ctx, port, version);
    const nodeServer = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
    if (await awaitListening(nodeServer)) return { port, nodeServer };
    log.debug(`port ${port} was taken between probe and bind — trying another`);
    nodeServer.close();
  }
  throw new Error(
    explicitPort
      ? `Synthra: port ${explicitPort} is already in use`
      : `Synthra: lost the race for a free port ${BIND_ATTEMPTS} times in a row`,
  );
}

export async function startServer(
  paths: SynthraPaths,
  options: StartOptions = {},
): Promise<ServerHandle> {
  // One owner per project (v0.26). If a server for THIS root is already
  // answering /health, defer to it instead of binding a rival that would
  // orphan it — the caller decides whether to reuse or refuse.
  if (!options.port) {
    const owner = await checkOwner(paths);
    if (owner.state === "live") {
      return {
        port: owner.record.port,
        url: `http://127.0.0.1:${owner.record.port}`,
        alreadyRunning: true,
        async stop() {},
      };
    }
    if (owner.state === "stale") {
      log.debug(`clearing a stale owner record (port ${owner.record.port} is dead)`);
    } else if (owner.state === "foreign") {
      log.warn(
        `port ${owner.record.port} is now served by a different project ` +
          `(${owner.servedRoot}) — taking a fresh port for this one.`,
      );
    }
  }

  const ctx = await loadContext(paths);
  const version = options.version ?? "unknown";
  const { port, nodeServer } = await bindServer(ctx, version, options.port);

  // Only now — with the port genuinely ours — tell the hooks where we are.
  await claimOwnership(paths, port, version);

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
      // Through the reindexer so a branch switch can't run a second scanner
      // alongside an in-flight edit-scan — both write the same graph files, and
      // whichever finishes last wins regardless of which saw the newer tree.
      // With auto-reindex off there's no competing scanner to coordinate with.
      if (reindexer) await reindexer.runNow(`branch ${to}`);
      else await rescanAndSwap(ctx, paths, `branch ${to}`);
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
      // Drop the port file + owner record so hooks can't keep POSTing at a
      // dead port (which they'd do silently). Only removes OUR record.
      await releaseOwnership(paths);
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
