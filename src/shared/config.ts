// Environment-variable-driven configuration.
// All knobs are prefixed SYN_.

export interface SynthraConfig {
  hardMaxReadChars: number;
  gateHintMaxChars: number;
  readDepsMaxChars: number;
  turnReadBudgetChars: number;
  fallbackMaxCallsPerTurn: number;
  retrieveCacheTtlSec: number;
  reindexDebounceMs: number;
  autoReindex: boolean;
  mcpPort: number | null;
  dashboardPort: number;
  logLevel: "debug" | "info" | "warn" | "error";
  claudeBin: string;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str<T extends string>(name: string, fallback: T): T {
  return (process.env[name] as T) ?? fallback;
}

export function loadConfig(): SynthraConfig {
  return {
    hardMaxReadChars: num("SYN_HARD_MAX_READ_CHARS", 4000),
    gateHintMaxChars: num("SYN_GATE_HINT_CHARS", 1200),
    readDepsMaxChars: num("SYN_READ_DEPS_CHARS", 900),
    turnReadBudgetChars: num("SYN_TURN_READ_BUDGET_CHARS", 18000),
    fallbackMaxCallsPerTurn: num("SYN_FALLBACK_MAX_CALLS_PER_TURN", 1),
    retrieveCacheTtlSec: num("SYN_RETRIEVE_CACHE_TTL_SEC", 900),
    // Auto-reindex: re-run the incremental scan + swap the in-memory graph this
    // many ms after the last source-file change, so graph reads never go stale
    // mid-session. Set SYN_NO_AUTOREINDEX to disable entirely.
    reindexDebounceMs: num("SYN_REINDEX_DEBOUNCE_MS", 1000),
    autoReindex: !process.env.SYN_NO_AUTOREINDEX,
    mcpPort: process.env.SYN_MCP_PORT ? num("SYN_MCP_PORT", 0) : null,
    dashboardPort: num("SYN_DASHBOARD_PORT", 8901),
    logLevel: str("SYN_LOG_LEVEL", "info" as const),
    claudeBin: str("SYN_CLAUDE_BIN", "claude" as const),
  };
}
