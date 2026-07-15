// Reads token_log.jsonl + gate_log.jsonl for the active project AND every
// project registered in ~/.synthra/projects.json, then computes the
// dashboard's rendered shape: per-project + global aggregate + recent calls
// across all projects.

import { readFile } from "node:fs/promises";

import { tokenizeQuery } from "../graph/rank.js";
import { readLearnStore } from "../learn/store.js";
import { effectiveScores, emptyStore, type LearnStore } from "../learn/usage.js";
import { resolvePaths, type SynthraPaths } from "../shared/paths.js";
import { estimateCostUsd } from "../shared/pricing.js";
import { listProjects } from "../shared/project-registry.js";

const AVG_TOKENS_PER_BLOCKED_GREP = 500;

export interface TokenLogEntry {
  /** Stop-hook-supplied timestamp (preferred). */
  ts?: string;
  /** Server-side fallback added by handleLog when ts isn't provided. */
  written_at?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model: string;
  description?: string;
  project: string;
}

export interface GateLogEntry {
  ts: string;
  tool: string;
  decision: "allow" | "block";
  query: string | null;
  /** Truncated to ~240 chars in the log; the full block hint lives only in the deny response. */
  reason?: string;
  /** Full length of the block hint delivered to the agent (v0.4.0+). */
  hint_chars?: number;
}

export interface ToolLogEntry {
  ts?: string;
  /** Synthra MCP tool name, e.g. "graph_continue", "graph_read". */
  tool: string;
}

/** A codebase-exploration Bash command the observer recorded (observe-only). */
export interface BashLogEntry {
  ts: string;
  kind: "search" | "read" | "list";
  tool: string;
  query: string | null;
  confidence: "low" | "medium" | "high" | null;
  /** True when the graph could have served this (a real Moat block, had we blocked Bash). */
  avoidable: boolean;
  command?: string;
}

/** A Dispatcher routing decision (UserPromptSubmit → /route), one per prompt. */
export interface RouteLogEntry {
  ts: string;
  prompt: string;
  /** True when a hint was actually injected into the conversation. */
  routed: boolean;
  hint_chars: number;
  difficulty: "standard" | "complex";
  /** Top recommended agent + its model (v0.19+; absent in older logs and when
   *  no agent cleared the confidence bar). */
  agent?: string;
  model?: string;
}

/** Aggregate routing decisions for the dashboard's Dispatcher card. Pure —
 *  agent counts only come from entries that carry the v0.19 `agent` field. */
export function summarizeRoutes(entries: RouteLogEntry[]): {
  total: number;
  hinted: number;
  complex: number;
  agents: Record<string, number>;
} {
  const agents: Record<string, number> = {};
  let hinted = 0;
  let complex = 0;
  for (const e of entries) {
    if (e.routed) hinted += 1;
    if (e.difficulty === "complex") complex += 1;
    if (e.agent) agents[e.agent] = (agents[e.agent] ?? 0) + 1;
  }
  return { total: entries.length, hinted, complex, agents };
}

/** A subagent dispatch the Stop hook spotted in the transcript (v0.20). */
export interface DelegationLogEntry {
  ts: string;
  agent?: string | null;
  model?: string | null;
  session_id?: string;
}

/** A hinted route counts as followed when a delegation lands within this
 *  window (cut short by the next hint). Crude but honest — logs carry no
 *  session ids, so time is the only join key. */
const FOLLOW_WINDOW_MS = 30 * 60 * 1000;

/** Did the routing hints actually change behavior? Pure — feeds the
 *  Dispatcher card's follow-rate line. */
export function correlateFollows(
  routes: RouteLogEntry[],
  delegations: DelegationLogEntry[],
): { hints: number; followed: number; followed_agent: number } {
  const hints = routes
    .filter((r) => r.routed)
    .map((r) => ({ t: Date.parse(r.ts), agent: r.agent }))
    .filter((h) => Number.isFinite(h.t))
    .sort((a, b) => a.t - b.t);
  const events = delegations
    .map((d) => ({ t: Date.parse(d.ts), agent: d.agent ?? null }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  let followed = 0;
  let followedAgent = 0;
  for (let i = 0; i < hints.length; i++) {
    const hint = hints[i] as { t: number; agent?: string };
    const next = hints[i + 1];
    const end = Math.min(hint.t + FOLLOW_WINDOW_MS, next ? next.t : Number.POSITIVE_INFINITY);
    const within = events.filter((e) => e.t > hint.t && e.t <= end);
    if (within.length === 0) continue;
    followed += 1;
    if (hint.agent && within.some((e) => e.agent === hint.agent)) followedAgent += 1;
  }
  return { hints: hints.length, followed, followed_agent: followedAgent };
}

/** A Moat block is "bypassed" when a terminal search lands soon after it and
 *  shares a token with the blocked query — the strongest false-block signal
 *  we can measure without asking the user. Pure. */
const BYPASS_WINDOW_MS = 120_000;

export function countBypassedBlocks(
  gates: GateLogEntry[],
  bash: BashLogEntry[],
): { blocks: number; bypassed: number } {
  const blocks = gates.filter((g) => g.decision === "block");
  const searches = bash
    .filter((b) => b.kind === "search")
    .map((b) => ({
      t: Date.parse(b.ts),
      tokens: tokenizeQuery(`${b.query ?? ""} ${b.command ?? ""}`),
    }))
    .filter((b) => Number.isFinite(b.t));

  let bypassed = 0;
  for (const g of blocks) {
    const gt = Date.parse(g.ts);
    if (!Number.isFinite(gt)) continue;
    const gTokens = new Set(tokenizeQuery(g.query ?? ""));
    if (gTokens.size === 0) continue;
    const hit = searches.some(
      (b) => b.t > gt && b.t - gt <= BYPASS_WINDOW_MS && b.tokens.some((t) => gTokens.has(t)),
    );
    if (hit) bypassed += 1;
  }
  return { blocks: blocks.length, bypassed };
}

/** Count Synthra MCP tool calls by tool name. (#2) */
export function countToolCalls(entries: ToolLogEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (!e.tool) continue;
    out[e.tool] = (out[e.tool] ?? 0) + 1;
  }
  return out;
}

export interface HotFile {
  path: string;
  score: number;
}

/** Top files by current (decayed-to-now) usage weight — surfaces what the
 *  usage-learning layer has learned this repo leans on. Ranked by effective
 *  score so recency matters; score rounded for display. */
export function topHotFiles(store: LearnStore, nowMs: number, limit = 8): HotFile[] {
  return [...effectiveScores(store, nowMs).entries()]
    .map(([path, score]) => ({ path, score: Math.round(score * 10) / 10 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface ProjectStats {
  path: string;
  name: string;
  last_seen: string | null;
  total_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_create: number;
  total_gate_calls: number;
  blocked_count: number;
  estimated_tokens_saved: number;
  estimated_cost_usd: number;
  total_tool_calls: number;
  tool_calls: Record<string, number>;
  /** Observe-only: codebase-exploration Bash calls (the Moat's terminal blind spot). */
  bash_explorations: number;
  /** Of those, how many the graph could have served (a would-be Moat block). */
  bash_avoidable: number;
  /** Dispatcher: prompts scored / hints injected / complex verdicts. */
  routes_total: number;
  routes_hinted: number;
  routes_complex: number;
  /** Hints followed by an actual subagent delegation (v0.20). */
  routes_followed: number;
  /** Of those, delegations to the exact recommended agent. */
  routes_followed_agent: number;
  /** Moat blocks bypassed via a terminal search soon after (v0.20). */
  blocks_bypassed: number;
  hot_files: HotFile[];
  hot_files_total: number;
  models: Record<string, number>;
}

export interface RecentTurn {
  ts: string;
  project_name: string;
  project_path: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  model: string;
  cost_usd: number;
}

export interface RecentGate {
  ts: string;
  project_name: string;
  project_path: string;
  tool: string;
  decision: "allow" | "block";
  query: string | null;
}

export interface RecentBash {
  ts: string;
  project_name: string;
  project_path: string;
  kind: "search" | "read" | "list";
  tool: string;
  query: string | null;
  confidence: "low" | "medium" | "high" | null;
  avoidable: boolean;
}

export interface RecentRoute {
  ts: string;
  project_name: string;
  project_path: string;
  prompt: string;
  routed: boolean;
  difficulty: "standard" | "complex";
  agent?: string;
  model?: string;
}

export interface DashboardData {
  active: {
    project_root: string;
    project_name: string;
    stats: ProjectStats;
  };
  global: {
    project_count: number;
    total_turns: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read: number;
    total_cache_create: number;
    total_gate_calls: number;
    blocked_count: number;
    estimated_tokens_saved: number;
    saved_percent: number;
    estimated_cost_usd: number;
    total_tool_calls: number;
    tool_calls: Record<string, number>;
    bash_explorations: number;
    bash_avoidable: number;
    routes_total: number;
    routes_hinted: number;
    routes_complex: number;
    routes_followed: number;
    routes_followed_agent: number;
    blocks_bypassed: number;
    /** Times each agent was the top recommendation (v0.19+ log entries only). */
    route_agents: Record<string, number>;
  };
  projects: ProjectStats[];
  recent_turns: RecentTurn[];
  recent_gates: RecentGate[];
  recent_bash: RecentBash[];
  recent_routes: RecentRoute[];
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          return null;
        }
      })
      .filter((v): v is T => v !== null);
  } catch {
    return [];
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

interface ProjectFiles {
  path: string;
  name: string;
  last_seen: string | null;
  tokens: TokenLogEntry[];
  gates: GateLogEntry[];
  tools: ToolLogEntry[];
  bash: BashLogEntry[];
  routes: RouteLogEntry[];
  delegations: DelegationLogEntry[];
  learn: LearnStore;
}

function summarize(p: ProjectFiles): ProjectStats {
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let costUsd = 0;
  const models: Record<string, number> = {};

  for (const t of p.tokens) {
    totalIn += t.input_tokens ?? 0;
    totalOut += t.output_tokens ?? 0;
    totalCacheRead += t.cache_read_input_tokens ?? 0;
    totalCacheCreate += t.cache_creation_input_tokens ?? 0;
    costUsd += estimateCostUsd(t);
    if (t.model) models[t.model] = (models[t.model] ?? 0) + 1;
  }

  const blocked = p.gates.filter((g) => g.decision === "block").length;
  const saved = blocked * AVG_TOKENS_PER_BLOCKED_GREP;
  const routes = summarizeRoutes(p.routes);
  const follows = correlateFollows(p.routes, p.delegations);
  const bypass = countBypassedBlocks(p.gates, p.bash);
  const now = Date.now();

  return {
    path: p.path,
    name: p.name,
    last_seen: p.last_seen,
    total_turns: p.tokens.length,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    total_cache_read: totalCacheRead,
    total_cache_create: totalCacheCreate,
    total_gate_calls: p.gates.length,
    blocked_count: blocked,
    estimated_tokens_saved: saved,
    estimated_cost_usd: Math.round(costUsd * 100) / 100,
    total_tool_calls: p.tools.length,
    tool_calls: countToolCalls(p.tools),
    bash_explorations: p.bash.length,
    bash_avoidable: p.bash.filter((b) => b.avoidable).length,
    routes_total: routes.total,
    routes_hinted: routes.hinted,
    routes_complex: routes.complex,
    routes_followed: follows.followed,
    routes_followed_agent: follows.followed_agent,
    blocks_bypassed: bypass.bypassed,
    hot_files: topHotFiles(p.learn, now),
    hot_files_total: effectiveScores(p.learn, now).size,
    models,
  };
}

// Dedupe is ON by default; set SYN_DASHBOARD_DEDUPE=0 (or "off"/"false") to see
// every raw token-log entry — including duplicates a co-installed AI tool's Stop
// hook may write to the same token_log.jsonl. (#7)
function dedupeEnabled(): boolean {
  const v = process.env.SYN_DASHBOARD_DEDUPE;
  return v !== "0" && v !== "off" && v !== "false";
}

async function loadProjectFiles(
  path: string,
  name: string,
  lastSeen: string | null,
): Promise<ProjectFiles> {
  const paths = resolvePaths(path);
  const [rawTokens, gates, tools, bash, routes, delegations, learn] = await Promise.all([
    readJsonl<TokenLogEntry>(paths.tokenLog),
    readJsonl<GateLogEntry>(paths.gateLog),
    readJsonl<ToolLogEntry>(paths.toolLog),
    readJsonl<BashLogEntry>(paths.bashLog),
    readJsonl<RouteLogEntry>(paths.routeLog),
    readJsonl<DelegationLogEntry>(paths.delegationLog),
    readLearnStore(paths.learnStore),
  ]);
  const tokens = dedupeEnabled() ? dedupeTokens(rawTokens) : rawTokens;
  return {
    path,
    name,
    last_seen: lastSeen,
    tokens,
    gates,
    tools,
    bash,
    routes,
    delegations,
    learn,
  };
}

/**
 * Collapse duplicate token-log entries from co-installed AI tools.
 *
 * Synthra is friendly with other tools that share the .synthra-graph/
 * token_log.jsonl shape — if a second tool's Stop hook also writes to
 * it, both fire on the same turn and emit nearly-identical entries
 * within ~10ms, double-counting every metric in the dashboard.
 *
 * Strategy: group by (project, usage counts, second-rounded timestamp);
 * inside a group, keep the entry with the most credible model field —
 * a real Claude model > "<synthetic>" > empty.
 */
function dedupeTokens(entries: TokenLogEntry[]): TokenLogEntry[] {
  const score = (model: string | undefined): number => {
    if (!model) return 0;
    if (model === "<synthetic>") return 1;
    return 2; // real model name
  };

  const groups = new Map<string, TokenLogEntry[]>();
  for (const e of entries) {
    const ts = e.ts ?? e.written_at ?? "";
    const second = ts.slice(0, 19); // YYYY-MM-DDTHH:mm:ss
    const key = [
      e.project ?? "",
      e.input_tokens ?? 0,
      e.output_tokens ?? 0,
      e.cache_creation_input_tokens ?? 0,
      e.cache_read_input_tokens ?? 0,
      second,
    ].join("|");
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  const out: TokenLogEntry[] = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      out.push(arr[0]!);
      continue;
    }
    arr.sort((a, b) => score(b.model) - score(a.model));
    out.push(arr[0]!);
  }

  // Preserve chronological order in the per-project list.
  out.sort((a, b) => {
    const at = a.ts ?? a.written_at ?? "";
    const bt = b.ts ?? b.written_at ?? "";
    return at.localeCompare(bt);
  });
  return out;
}

export async function computeDashboardData(
  activePaths: SynthraPaths,
  recentN = 500,
): Promise<DashboardData> {
  const registered = await listProjects();

  // Always include the active project, even if not yet in the registry.
  const activePath = activePaths.projectRoot;
  const activeName = basename(activePath);
  const knownPaths = new Set(registered.map((p) => p.path));
  const allEntries: Array<{ path: string; name: string; last_seen: string | null }> = [
    ...registered.map((p) => ({ path: p.path, name: p.name, last_seen: p.last_seen })),
  ];
  if (!knownPaths.has(activePath)) {
    allEntries.unshift({ path: activePath, name: activeName, last_seen: null });
  }

  const loaded = await Promise.all(
    allEntries.map((e) => loadProjectFiles(e.path, e.name, e.last_seen)),
  );

  const projects = loaded
    .map(summarize)
    .sort(
      (a, b) =>
        b.total_input_tokens +
        b.total_output_tokens -
        (a.total_input_tokens + a.total_output_tokens),
    );

  const activeFiles = loaded.find((p) => p.path === activePath) ?? {
    path: activePath,
    name: activeName,
    last_seen: null,
    tokens: [],
    gates: [],
    tools: [],
    bash: [],
    routes: [],
    delegations: [],
    learn: emptyStore(),
  };
  const activeStats = summarize(activeFiles);

  // Global aggregates
  let g_in = 0,
    g_out = 0,
    g_cr = 0,
    g_cc = 0,
    g_gate = 0,
    g_block = 0,
    g_cost = 0,
    g_turns = 0,
    g_tools = 0,
    g_bash = 0,
    g_bash_avoid = 0,
    g_routes = 0,
    g_routes_hinted = 0,
    g_routes_complex = 0,
    g_routes_followed = 0,
    g_routes_followed_agent = 0,
    g_blocks_bypassed = 0;
  const g_tool_calls: Record<string, number> = {};
  for (const s of projects) {
    g_turns += s.total_turns;
    g_in += s.total_input_tokens;
    g_out += s.total_output_tokens;
    g_cr += s.total_cache_read;
    g_cc += s.total_cache_create;
    g_gate += s.total_gate_calls;
    g_block += s.blocked_count;
    g_cost += s.estimated_cost_usd;
    g_tools += s.total_tool_calls;
    g_bash += s.bash_explorations;
    g_bash_avoid += s.bash_avoidable;
    g_routes += s.routes_total;
    g_routes_hinted += s.routes_hinted;
    g_routes_complex += s.routes_complex;
    g_routes_followed += s.routes_followed;
    g_routes_followed_agent += s.routes_followed_agent;
    g_blocks_bypassed += s.blocks_bypassed;
    for (const [k, v] of Object.entries(s.tool_calls)) g_tool_calls[k] = (g_tool_calls[k] ?? 0) + v;
  }
  const g_route_agents: Record<string, number> = {};
  for (const p of loaded) {
    for (const [k, v] of Object.entries(summarizeRoutes(p.routes).agents)) {
      g_route_agents[k] = (g_route_agents[k] ?? 0) + v;
    }
  }
  const g_saved = g_block * AVG_TOKENS_PER_BLOCKED_GREP;
  const g_used = g_in + g_out + g_cc;
  const g_saved_pct = g_used + g_saved > 0 ? (g_saved / (g_used + g_saved)) * 100 : 0;

  // Recent turns + gates + bash hunts across all projects, sorted by ts descending
  const allTurns: RecentTurn[] = [];
  const allGates: RecentGate[] = [];
  const allBash: RecentBash[] = [];
  const allRoutes: RecentRoute[] = [];
  for (const p of loaded) {
    for (const r of p.routes) {
      allRoutes.push({
        ts: r.ts,
        project_name: p.name,
        project_path: p.path,
        prompt: r.prompt,
        routed: r.routed,
        difficulty: r.difficulty,
        ...(r.agent ? { agent: r.agent } : {}),
        ...(r.model ? { model: r.model } : {}),
      });
    }
    for (const b of p.bash) {
      allBash.push({
        ts: b.ts,
        project_name: p.name,
        project_path: p.path,
        kind: b.kind,
        tool: b.tool,
        query: b.query,
        confidence: b.confidence,
        avoidable: b.avoidable,
      });
    }
    for (const t of p.tokens) {
      allTurns.push({
        // Fall back to written_at — the Stop hook today posts entries without
        // a `ts` field, and the server tags them with written_at on receive.
        ts: t.ts ?? t.written_at ?? "",
        project_name: p.name,
        project_path: p.path,
        input: t.input_tokens ?? 0,
        output: t.output_tokens ?? 0,
        cache_read: t.cache_read_input_tokens ?? 0,
        cache_create: t.cache_creation_input_tokens ?? 0,
        model: t.model ?? "",
        cost_usd: Math.round(estimateCostUsd(t) * 1000) / 1000,
      });
    }
    for (const gate of p.gates) {
      allGates.push({
        ts: gate.ts,
        project_name: p.name,
        project_path: p.path,
        tool: gate.tool,
        decision: gate.decision,
        query: gate.query,
      });
    }
  }
  allTurns.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  allGates.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  allBash.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  allRoutes.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return {
    active: {
      project_root: activePath,
      project_name: activeName,
      stats: activeStats,
    },
    global: {
      project_count: projects.length,
      total_turns: g_turns,
      total_input_tokens: g_in,
      total_output_tokens: g_out,
      total_cache_read: g_cr,
      total_cache_create: g_cc,
      total_gate_calls: g_gate,
      blocked_count: g_block,
      estimated_tokens_saved: g_saved,
      saved_percent: Math.round(g_saved_pct * 10) / 10,
      estimated_cost_usd: Math.round(g_cost * 100) / 100,
      total_tool_calls: g_tools,
      tool_calls: g_tool_calls,
      bash_explorations: g_bash,
      bash_avoidable: g_bash_avoid,
      routes_total: g_routes,
      routes_hinted: g_routes_hinted,
      routes_complex: g_routes_complex,
      routes_followed: g_routes_followed,
      routes_followed_agent: g_routes_followed_agent,
      blocks_bypassed: g_blocks_bypassed,
      route_agents: g_route_agents,
    },
    projects,
    recent_turns: allTurns.slice(0, recentN),
    recent_gates: allGates.slice(0, recentN),
    recent_bash: allBash.slice(0, recentN),
    recent_routes: allRoutes.slice(0, recentN),
  };
}

// Legacy shapes from the M2 stub — kept for compat.
export interface TurnBreakdown {
  systemPromptTokens: number;
  conversationHistoryTokens: number;
  synthraPackTokens: number;
  userMessageTokens: number;
  responseTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface SavingsDelta {
  withSynthra: TurnBreakdown;
  estimatedWithoutSynthra: TurnBreakdown;
  savedUsd: number;
  savedPercent: number;
}

export function computeDelta(breakdown: TurnBreakdown, blockedGreps: number): SavingsDelta {
  const savedTokens = blockedGreps * AVG_TOKENS_PER_BLOCKED_GREP;
  const without: TurnBreakdown = {
    ...breakdown,
    conversationHistoryTokens: breakdown.conversationHistoryTokens + savedTokens,
    totalTokens: breakdown.totalTokens + savedTokens,
    costUsd: breakdown.costUsd + (savedTokens / 1_000_000) * 3,
  };
  const savedUsd = without.costUsd - breakdown.costUsd;
  const savedPercent = without.totalTokens > 0 ? (savedTokens / without.totalTokens) * 100 : 0;
  return {
    withSynthra: breakdown,
    estimatedWithoutSynthra: without,
    savedUsd,
    savedPercent: Math.round(savedPercent * 10) / 10,
  };
}
