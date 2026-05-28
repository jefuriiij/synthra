// Standalone dashboard server on 8901 (default; override via SYN_DASHBOARD_PORT).
// Reads .synthra-graph/token_log.jsonl + .synthra-graph/gate_log.jsonl for the
// given project and renders a live SPA backed by GET /data polled every 2s.

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { SynthraPaths } from "../shared/paths.js";
import { computeDashboardData } from "./delta.js";

import indexHtml from "./public/index.html";
import styleCss from "./public/style.css";

export interface DashboardServerHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export async function startDashboard(
  paths: SynthraPaths,
  port = 8901,
): Promise<DashboardServerHandle> {
  const app = new Hono();

  app.get("/", (c) => c.html(indexHtml));

  app.get("/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(styleCss);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/data", async (c) => {
    const data = await computeDashboardData(paths);
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
