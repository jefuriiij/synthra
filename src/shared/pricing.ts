// Approximate per-million-token pricing for Claude models, in USD.
// Sourced from Anthropic's published rates. Tilde everywhere — these can shift.
//
// Used only for the dashboard's "~$X" estimate; not for billing.

export interface ModelPricing {
  /** Cost per 1M raw-input tokens. */
  input: number;
  /** Cost per 1M output tokens. */
  output: number;
  /** Cost per 1M cache-read tokens (typically ~10% of input). */
  cacheRead: number;
  /** Cost per 1M cache-creation tokens (typically input × 1.25). */
  cacheCreate: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Opus-class models — premium tier
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  "claude-opus-4-5": { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  // Sonnet-class — workhorse
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  // Haiku-class — fast and cheap
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 },
};

const FALLBACK: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };

export function pricingFor(model: string | undefined | null): ModelPricing {
  if (!model) return FALLBACK;
  const direct = PRICING[model];
  if (direct) return direct;
  // Loose prefix match: "claude-opus-…" / "claude-sonnet-…" / "claude-haiku-…"
  if (model.includes("opus")) return PRICING["claude-opus-4-7"] ?? FALLBACK;
  if (model.includes("sonnet")) return PRICING["claude-sonnet-4-6"] ?? FALLBACK;
  if (model.includes("haiku")) return PRICING["claude-haiku-4-5"] ?? FALLBACK;
  return FALLBACK;
}

export interface UsageRecord {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model?: string;
}

/** Approximate USD cost of a single usage record. */
export function estimateCostUsd(usage: UsageRecord): number {
  const p = pricingFor(usage.model);
  return (
    (usage.input_tokens / 1_000_000) * p.input +
    (usage.output_tokens / 1_000_000) * p.output +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheRead +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheCreate
  );
}
