// POST /route — the UserPromptSubmit hook sends each user prompt here; the
// response's `hint` (when non-empty) is injected into the conversation as
// added context. The scoring itself lives in route-match.ts; this handler is
// the thin, best-effort wiring: config gate, arsenal fetch (15s-cached),
// project fingerprint from the graph, and a route_log.jsonl trail for the
// dogfood. A failure anywhere returns an empty hint — never break a prompt.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { computeArsenal, type ArsenalData } from "../../dashboard/arsenal.js";
import type { FileNode } from "../../graph/types.js";
import { loadConfig } from "../../shared/config.js";
import type { ServerContext } from "../context.js";
import { renderHint, scoreArsenal, type RouteMatch } from "./route-match.js";

export interface RouteRequest {
  prompt?: string;
}

export interface RouteResponse {
  hint: string;
}

export interface RouteDeps {
  /** Injectable for tests — defaults to the cached machine-wide arsenal scan. */
  arsenal: (projectRoot: string) => Promise<ArsenalData>;
}

const defaultDeps: RouteDeps = { arsenal: (root) => computeArsenal(root) };

export function graphExtCounts(ctx: ServerContext): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of ctx.graph.nodes) {
    if (n.kind !== "file") continue;
    const ext = (n as FileNode).ext;
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return counts;
}

const PROMPT_LOG_MAX = 200;

async function logRoute(
  ctx: ServerContext,
  prompt: string,
  hint: string,
  match: RouteMatch,
): Promise<void> {
  try {
    await mkdir(dirname(ctx.paths.routeLog), { recursive: true });
    const top = match.confident ? match.agents[0] : undefined;
    const entry = {
      ts: new Date().toISOString(),
      prompt: prompt.length > PROMPT_LOG_MAX ? `${prompt.slice(0, PROMPT_LOG_MAX)}…` : prompt,
      routed: hint.length > 0,
      hint_chars: hint.length,
      // Grade the v0.18 difficulty heuristic from the field: this trail is how
      // we learn whether ≥2 hard-signal words is the right bar.
      difficulty: match.difficulty,
      // Which recommendation actually fired (v0.19, feeds the dashboard's
      // Dispatcher card). Omitted when no agent cleared the confidence bar.
      ...(top ? { agent: top.name, model: top.model } : {}),
    };
    await appendFile(ctx.paths.routeLog, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // best-effort
  }
}

export async function handleRoute(
  req: RouteRequest,
  ctx: ServerContext,
  deps: RouteDeps = defaultDeps,
): Promise<RouteResponse> {
  const cfg = loadConfig();
  if (!cfg.route) return { hint: "" };
  const prompt = typeof req?.prompt === "string" ? req.prompt.trim() : "";
  if (!prompt) return { hint: "" };

  try {
    const arsenal = await deps.arsenal(ctx.paths.projectRoot);
    const match = scoreArsenal(prompt, arsenal, graphExtCounts(ctx), cfg.routeMinScore);
    const hint = renderHint(match);
    await logRoute(ctx, prompt, hint, match);
    return { hint };
  } catch {
    return { hint: "" };
  }
}
