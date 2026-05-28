// Reads token_log.jsonl + gate_log.jsonl for the active project AND every
// project registered in ~/.synthra/projects.json, then computes the
// dashboard's rendered shape: per-project + global aggregate + recent calls
// across all projects.

import { readFile } from "node:fs/promises";

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
  reason?: string;
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
  };
  projects: ProjectStats[];
  recent_turns: RecentTurn[];
  recent_gates: RecentGate[];
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
    models,
  };
}

async function loadProjectFiles(
  path: string,
  name: string,
  lastSeen: string | null,
): Promise<ProjectFiles> {
  const paths = resolvePaths(path);
  const [tokens, gates] = await Promise.all([
    readJsonl<TokenLogEntry>(paths.tokenLog),
    readJsonl<GateLogEntry>(paths.gateLog),
  ]);
  return { path, name, last_seen: lastSeen, tokens, gates };
}

export async function computeDashboardData(
  activePaths: SynthraPaths,
  recentN = 25,
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
    .sort((a, b) => b.total_input_tokens + b.total_output_tokens - (a.total_input_tokens + a.total_output_tokens));

  const activeFiles =
    loaded.find((p) => p.path === activePath) ?? {
      path: activePath,
      name: activeName,
      last_seen: null,
      tokens: [],
      gates: [],
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
    g_turns = 0;
  for (const s of projects) {
    g_turns += s.total_turns;
    g_in += s.total_input_tokens;
    g_out += s.total_output_tokens;
    g_cr += s.total_cache_read;
    g_cc += s.total_cache_create;
    g_gate += s.total_gate_calls;
    g_block += s.blocked_count;
    g_cost += s.estimated_cost_usd;
  }
  const g_saved = g_block * AVG_TOKENS_PER_BLOCKED_GREP;
  const g_used = g_in + g_out + g_cc;
  const g_saved_pct = g_used + g_saved > 0 ? (g_saved / (g_used + g_saved)) * 100 : 0;

  // Recent turns + gates across all projects, sorted by ts descending
  const allTurns: RecentTurn[] = [];
  const allGates: RecentGate[] = [];
  for (const p of loaded) {
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
    },
    projects,
    recent_turns: allTurns.slice(0, recentN),
    recent_gates: allGates.slice(0, recentN),
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
