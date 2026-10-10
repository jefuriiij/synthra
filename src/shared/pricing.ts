// Per-million-token prices for Claude models, in USD, for the dashboard's cost
// estimate (never for billing).
//
// Source: platform.claude.com/docs/en/about-claude/pricing, checked
// 2026-10-10. Cache writes use the 5-minute rate: the token log does not say
// which cache lifetime a write used, and Claude Code writes 5-minute entries.
// Update this table when Anthropic changes a price; tests/pricing.test.ts
// pins every row.

export interface ModelPricing {
  /** Cost per 1M raw-input tokens. */
  input: number;
  /** Cost per 1M output tokens. */
  output: number;
  /** Cost per 1M cache-read tokens ("cache hits and refreshes"). */
  cacheRead: number;
  /** Cost per 1M cache-creation tokens (5-minute cache writes). */
  cacheCreate: number;
}

const p = (
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
): ModelPricing => ({
  input,
  output,
  cacheRead,
  cacheCreate,
});

/** By family, then version ("5.5", "4.7", "5"). */
const PRICES: Record<string, Record<string, ModelPricing>> = {
  fable: { "5.1": p(10, 50, 0.25, 12.5), "5": p(10, 50, 1, 12.5) },
  mythos: { "5.1": p(10, 50, 0.25, 12.5), "5": p(10, 50, 1, 12.5) },
  opus: {
    "5.5": p(4, 20, 0.2, 5),
    "5": p(5, 25, 0.5, 6.25),
    "4.8": p(5, 25, 0.5, 6.25),
    "4.7": p(5, 25, 0.5, 6.25),
    "4.6": p(5, 25, 0.5, 6.25),
    "4.5": p(5, 25, 0.5, 6.25),
    // Opus 4 and 4.1 kept their launch prices.
    "4.1": p(15, 75, 1.5, 18.75),
    "4": p(15, 75, 1.5, 18.75),
  },
  sonnet: {
    "5.5": p(2, 10, 0.1, 2.5),
    "5": p(2, 10, 0.2, 2.5),
    "4.6": p(3, 15, 0.3, 3.75),
    "4.5": p(3, 15, 0.3, 3.75),
    "4": p(3, 15, 0.3, 3.75),
  },
  haiku: { "5.5": p(0.1, 0.5, 0.01, 0.125), "4.5": p(1, 5, 0.1, 1.25) },
};

/** Haiku 5.5 charges more for a request whose prompt (input, cache reads and
 *  cache writes together) is over 100,000 tokens. Only Haiku 5.5 has a tier. */
const HAIKU_5_5_LONG = p(0.5, 2.5, 0.05, 0.625);
const HAIKU_5_5_TIER_TOKENS = 100_000;

const FALLBACK = p(3, 15, 0.3, 3.75);

const num = (v: string) => v.split(".").map(Number);
const cmp = (a: string, b: string) => {
  const [a1 = 0, a2 = 0] = num(a);
  const [b1 = 0, b2 = 0] = num(b);
  return a1 - b1 || a2 - b2;
};

/**
 * "claude-opus-5-5", "claude-opus-4-7[1m]", "claude-haiku-4-5-20251001",
 * "us.anthropic.claude-sonnet-4-6-v1:0" → family and "major.minor" version.
 * A trailing date or provider suffix is not a version.
 */
function parse(model: string): { family: string; version: string } | null {
  const m = /claude-(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(model);
  if (!m?.[1] || !m[2]) return null;
  return { family: m[1].toLowerCase(), version: m[3] ? `${m[2]}.${m[3]}` : m[2] };
}

/** The price of a model: its exact version, else the newest known version not
 *  newer than it (a new point release), else the oldest of its family. */
export function pricingFor(model: string | undefined | null): ModelPricing {
  const id = model ? parse(model) : null;
  const family = id ? PRICES[id.family] : undefined;
  if (!id || !family) return FALLBACK;
  const exact = family[id.version];
  if (exact) return exact;
  const versions = Object.keys(family).sort(cmp);
  const below = versions.filter((v) => cmp(v, id.version) <= 0).pop();
  return family[below ?? (versions[0] as string)] ?? FALLBACK;
}

export interface UsageRecord {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model?: string;
  /** "codex" for turns Codex's Stop hook logged (v0.42). */
  agent?: string;
}

/** Models from other vendors, such as Codex's GPT models. Synthra has no
 *  prices for them and a Codex plan is a flat fee, so they cost nothing here;
 *  the fallback would have charged them as Sonnet. */
const OTHER_VENDOR = /^(gpt|o\d|codex|chatgpt)/i;

/** Approximate USD cost of a single usage record (one request). */
export function estimateCostUsd(usage: UsageRecord): number {
  if (usage.agent === "codex" || (usage.model && OTHER_VENDOR.test(usage.model))) return 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const id = usage.model ? parse(usage.model) : null;
  const long =
    id?.family === "haiku" &&
    id.version === "5.5" &&
    usage.input_tokens + read + write > HAIKU_5_5_TIER_TOKENS;
  const price = long ? HAIKU_5_5_LONG : pricingFor(usage.model);
  return (
    (usage.input_tokens / 1_000_000) * price.input +
    (usage.output_tokens / 1_000_000) * price.output +
    (read / 1_000_000) * price.cacheRead +
    (write / 1_000_000) * price.cacheCreate
  );
}
