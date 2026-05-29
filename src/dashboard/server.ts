// Standalone dashboard server. Default port 8901 (override via
// SYN_DASHBOARD_PORT); falls back through a small range 8901–8910 if the
// preferred port is busy (so we can coexist with other co-installed
// AI-context tools that also expose a dashboard).
// Reads .synthra-graph/token_log.jsonl + .synthra-graph/gate_log.jsonl for the
// given project and renders a live SPA backed by GET /data polled every 2s.

import { serve } from "@hono/node-server";
import { Hono } from "hono";

// Tsup inlines this import at build time so `c.html` can echo whatever
// version is running. Replaces the v__SYN_VERSION__ placeholder in the
// dashboard footer on every GET /.
import pkgJson from "../../package.json" with { type: "json" };

import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import { findFreePort } from "../server/port.js";
import { computeDashboardData } from "./delta.js";

import indexHtml from "./public/index.html";
import styleCss from "./public/style.css";

const FALLBACK_RANGE = 9; // try preferredPort + [0..9]
const VERSION = (pkgJson as { version: string }).version;
// How many recent turns/gates the /data payload carries. The dashboard
// paginates turns client-side (25/page); the donut uses the uncapped
// per-project model aggregate, so it isn't bounded by this.
const RECENT_N = Number(process.env.SYN_DASHBOARD_RECENT_N) || 500;

export interface DashboardServerHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export async function startDashboard(
  paths: SynthraPaths,
  preferredPort = 8901,
): Promise<DashboardServerHandle> {
  const port = await findFreePort(preferredPort, preferredPort + FALLBACK_RANGE);
  if (port !== preferredPort) {
    log.info(
      `dashboard port ${preferredPort} was busy — bound to ${port} instead (likely another dashboard from a coexisting tool).`,
    );
  }
  const app = new Hono();

  app.get("/", (c) => c.html(indexHtml.replaceAll("__SYN_VERSION__", VERSION)));

  app.get("/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(styleCss);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/data", async (c) => {
    const data = await computeDashboardData(paths, RECENT_N);
    return c.json(data);
  });

  const nodeServer = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
