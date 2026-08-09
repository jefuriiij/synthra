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
  bashObserve: boolean;
  route: boolean;
  routeHints: boolean;
  routeMinScore: number;
  mcpPort: number | null;
  dashboardPort: number;
  allowedHosts: string[];
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

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    // Observe-only: log codebase-exploration Bash commands (grep/cat/find …) so
    // the terminal bypass of the Moat can be measured. Never blocks. Opt out
    // with SYN_NO_BASH_OBSERVE.
    bashObserve: !process.env.SYN_NO_BASH_OBSERVE,
    // The Dispatcher: scores every prompt against the installed Arsenal and
    // logs the verdict. SYN_NO_ROUTE turns the whole thing off.
    route: !process.env.SYN_NO_ROUTE,
    // Injection is OFF by default (v0.21) — "shadow mode": Synthra records what
    // it would have recommended so precision can be graded from route_log,
    // without spending a line of your context on it. The first field window
    // measured a 1.2% follow-rate on injected hints, so they have to earn the
    // right to speak again. SYN_ROUTE_HINTS=1 re-enables injection.
    routeHints: process.env.SYN_ROUTE_HINTS === "1",
    // A strong name hit (3) plus two description hits, or five description
    // hits. Raised from 3 in v0.21 alongside the precision fixes.
    routeMinScore: num("SYN_ROUTE_MIN_SCORE", 5),
    mcpPort: process.env.SYN_MCP_PORT ? num("SYN_MCP_PORT", 0) : null,
    dashboardPort: num("SYN_DASHBOARD_PORT", 8901),
    // Extra hostnames both servers will answer on, beyond localhost. Needed
    // only when reaching Synthra from another device (LAN, tunnel, container) —
    // everything else is refused so a browser can't be tricked into relaying
    // for a remote page. Comma-separated; "host" matches any port, "host:8901"
    // pins one.
    allowedHosts: list("SYN_ALLOWED_HOSTS"),
    logLevel: str("SYN_LOG_LEVEL", "info" as const),
    claudeBin: str("SYN_CLAUDE_BIN", "claude" as const),
  };
}
