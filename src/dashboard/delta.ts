// Reads token_log.jsonl + gate_log.jsonl and computes the dashboard's
// rendered shape: per-turn breakdown + estimated savings.
//
// "Estimated savings" is approximate: blocked-Grep count × an average
// tokens-per-Grep heuristic. Real impact is also driven by avoided cache
// thrash, but that's hard to attribute precisely — we under-count rather
// than over-claim.

import { readFile } from "node:fs/promises";

const AVG_TOKENS_PER_BLOCKED_GREP = 500;

export interface TokenLogEntry {
  ts: string;
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

export interface DashboardData {
  summary: {
    total_turns: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read: number;
    total_cache_create: number;
    total_gate_calls: number;
    blocked_count: number;
    estimated_tokens_saved: number;
    saved_percent: number;
  };
  recent_turns: Array<{
    ts: string;
    input: number;
    output: number;
    cache_read: number;
    cache_create: number;
    model: string;
  }>;
  recent_gates: Array<{
    ts: string;
    tool: string;
    decision: "allow" | "block";
    query: string | null;
  }>;
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

export async function computeDashboardData(
  tokenLogPath: string,
  gateLogPath: string,
  recentN = 25,
): Promise<DashboardData> {
  const [tokens, gates] = await Promise.all([
    readJsonl<TokenLogEntry>(tokenLogPath),
    readJsonl<GateLogEntry>(gateLogPath),
  ]);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;

  for (const t of tokens) {
    totalInput += t.input_tokens ?? 0;
    totalOutput += t.output_tokens ?? 0;
    totalCacheRead += t.cache_read_input_tokens ?? 0;
    totalCacheCreate += t.cache_creation_input_tokens ?? 0;
  }

  const blocked_count = gates.filter((g) => g.decision === "block").length;
  const estimated_tokens_saved = blocked_count * AVG_TOKENS_PER_BLOCKED_GREP;
  const totalUsed = totalInput + totalOutput + totalCacheCreate;
  const denom = totalUsed + estimated_tokens_saved;
  const saved_percent = denom > 0 ? (estimated_tokens_saved / denom) * 100 : 0;

  return {
    summary: {
      total_turns: tokens.length,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_cache_read: totalCacheRead,
      total_cache_create: totalCacheCreate,
      total_gate_calls: gates.length,
      blocked_count,
      estimated_tokens_saved,
      saved_percent: Math.round(saved_percent * 10) / 10,
    },
    recent_turns: tokens.slice(-recentN).map((t) => ({
      ts: t.ts ?? "",
      input: t.input_tokens ?? 0,
      output: t.output_tokens ?? 0,
      cache_read: t.cache_read_input_tokens ?? 0,
      cache_create: t.cache_creation_input_tokens ?? 0,
      model: t.model ?? "",
    })),
    recent_gates: gates.slice(-recentN).map((g) => ({
      ts: g.ts,
      tool: g.tool,
      decision: g.decision,
      query: g.query,
    })),
  };
}

// Backwards-compat shape from the M2 stub.
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

// Kept for completeness — the dashboard uses computeDashboardData() instead.
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
