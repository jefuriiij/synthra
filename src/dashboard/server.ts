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

import { buildDiagnosticReport, runDoctorChecks } from "../cli/doctor-command.js";
import { loadConfig } from "../shared/config.js";
import { forbiddenHostMessage, isAllowedHost } from "../shared/host-guard.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import { findFreePort } from "../server/port.js";
import { computeDashboardData } from "./delta.js";

// The dashboard UI is built by Vite (svelte + tailwind) into a single
// self-contained HTML (JS+CSS inlined) at ./built/index.html; tsup text-inlines
// it here. See vite.config.dashboard.ts. CSS is inside the HTML — no /style.css.
import indexHtml from "./built/index.html";
import faviconSvg from "./public/favicon.svg";

const FALLBACK_RANGE = 9; // try preferredPort + [0..9]
const VERSION = (pkgJson as { version: string }).version;
// The turn-history depth lives in delta.ts (RECENT_TURNS_N); undefined here
// keeps that default unless SYN_DASHBOARD_RECENT_N overrides it.
const RECENT_N = Number(process.env.SYN_DASHBOARD_RECENT_N) || undefined;

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

  // Same guard as the MCP server, for the same reason: binding 127.0.0.1 does
  // not stop a page in the user's browser from being tricked into relaying for
  // a remote attacker (DNS rebinding — see shared/host-guard.ts). This server
  // hands out /report and /data.
  const allowedHosts = loadConfig().allowedHosts;
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (!isAllowedHost(host, port, allowedHosts)) {
      log.warn(`dashboard refused request with Host: ${host ?? "(none)"}`);
      return c.json({ error: forbiddenHostMessage(host) }, 403);
    }
    await next();
  });

  app.get("/", (c) => c.html(indexHtml.replaceAll("__SYN_VERSION__", VERSION)));

  app.get("/favicon.svg", (c) => {
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(faviconSvg);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Diagnostic for the Report dialog: runs the doctor checks and prebuilds the
  // redacted markdown so the UI copies exactly what `syn doctor --report` emits.
  // Nothing is sent anywhere — the user copies + pastes it into a GitHub issue.
  app.get("/report", async (c) => {
    const checks = await runDoctorChecks(paths.projectRoot);
    const info = {
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      claudeBin: loadConfig().claudeBin,
    };
    return c.json({ ...info, checks, markdown: buildDiagnosticReport(checks, info) });
  });

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
