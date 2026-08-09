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
import { parseFavoriteRequest, readFavorites, setFavorite } from "../shared/favorites.js";
import { computeArsenal, computeArsenalDetail, isArsenalKind, isArsenalScope } from "./arsenal.js";
import { computeDashboardData } from "./delta.js";
import { checkLocalJsonPost } from "./origin-guard.js";

// The dashboard UI is built by Vite (svelte + tailwind) into a single
// self-contained HTML (JS+CSS inlined) at ./built/index.html; tsup text-inlines
// it here. See vite.config.dashboard.ts. CSS is inside the HTML — no /style.css.
import indexHtml from "./built/index.html";
import faviconSvg from "./public/favicon.svg";

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

  // Same guard as the MCP server, for the same reason: binding 127.0.0.1 does
  // not stop a page in the user's browser from being tricked into relaying for
  // a remote attacker (DNS rebinding — see shared/host-guard.ts). This server
  // hands out /report, /data and any skill's file body via /arsenal/item.
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

  // Installed skills / agents / MCP servers (project · personal · plugin).
  // Fetched lazily when the Arsenal drawer opens — not on the /data poll.
  app.get("/arsenal", async (c) => c.json(await computeArsenal(paths.projectRoot)));

  // Full source for ONE arsenal item — backs the detail modal. The client sends
  // only the identity it already holds from /arsenal, never a filesystem path;
  // the server re-resolves name → file through its own scan index, so there is
  // no traversal surface here. Query params (not path segments) because item
  // names legitimately contain ":" and spaces.
  app.get("/arsenal/item", async (c) => {
    const kind = c.req.query("kind");
    const scope = c.req.query("scope");
    const name = c.req.query("name") ?? "";
    const source = c.req.query("source") || undefined;
    if (!isArsenalKind(kind) || !isArsenalScope(scope) || !name) {
      return c.json({ error: "kind, scope and name are required" }, 400);
    }
    const detail = await computeArsenalDetail(paths.projectRoot, { kind, scope, name, source });
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  // Favorited skills/agents, machine-wide (~/.synthra/favorites.json). Browsing
  // only — nothing in the routing path reads these, so a favorite can never
  // change which agent Claude gets pointed at.
  app.get("/favorites", async (c) => c.json({ favorites: (await readFavorites()).favorites }));

  // The dashboard's only mutating route. `favorite` is an explicit boolean
  // rather than a toggle, so a double-clicked heart is idempotent instead of a
  // coin flip. Responds with the full list so the client reconciles against the
  // server rather than guessing — which also heals two tabs drifting apart.
  app.post("/favorites", async (c) => {
    const guard = checkLocalJsonPost(c.req.header("content-type"), c.req.header("origin"), port);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const parsed = parseFavoriteRequest(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    try {
      return c.json({ ok: true, ...(await setFavorite(parsed.id, parsed.favorite)) });
    } catch (err) {
      // Deliberately NOT the house best-effort swallow: the user clicked a heart
      // and is watching it, so a silent failure would leave the UI lying.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`favorites write failed: ${message}`);
      return c.json({ ok: false, error: message }, 500);
    }
  });

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
