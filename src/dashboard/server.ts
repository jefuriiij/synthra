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
import { type SynthraPaths, pathKey } from "../shared/paths.js";
import { pickProject } from "./pick-project.js";
import { findFreePort } from "../server/port.js";
import { computeDashboardData } from "./delta.js";
import { type OverviewData, computeOverview } from "./overview.js";
import { handleRepair } from "./repair.js";

// The dashboard UI is built by Vite (svelte + tailwind) into a single
// self-contained HTML (JS+CSS inlined) at ./built/index.html; tsup text-inlines
// it here. See vite.config.dashboard.ts. CSS is inside the HTML — no /style.css.
import indexHtml from "./built/index.html";
import faviconSvg from "./public/favicon.svg";

const FALLBACK_RANGE = 9; // try preferredPort + [0..9]
const OVERVIEW_TTL_MS = 10_000;
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

  // The report card. Reads a few dozen small files per project, so it is
  // memoized briefly: two tabs, or a poll and a click, share one read.
  // Any window's dashboard shows any project: ?project=<path> picks one, but
  // only a project in the registry (or this window's own), never any path.
  const overviewMemo = new Map<string, { at: number; data: OverviewData }>();
  app.get("/overview", async (c) => {
    const days = c.req.query("days") === "30" ? 30 : 7;
    const target = await pickProject(paths, c.req.query("project"));
    if (!target) return c.json({ error: "Synthra doesn't know that project." }, 404);
    const key = `${days}|${pathKey(target.projectRoot)}`;
    const hit = overviewMemo.get(key);
    if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS) return c.json(hit.data);
    const data = await computeOverview(target, {
      days,
      version: VERSION,
      home: paths.projectRoot,
    });
    overviewMemo.set(key, { at: Date.now(), data });
    return c.json(data);
  });

  // "Fix hooks" (repair.ts): rewrite one known project's hooks.
  app.post("/repair", async (c) => {
    const r = await handleRepair(
      {
        contentType: c.req.header("content-type"),
        origin: c.req.header("origin"),
        body: await c.req.json().catch(() => null),
      },
      paths,
      port,
    );
    if (r.status === 200) overviewMemo.clear();
    return c.json(r.body, r.status);
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
