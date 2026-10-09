// Pricing table + model resolution. Added with Fable support (v0.4.1) — the
// loose family match must catch suffixed IDs like "claude-fable-5[1m]", and
// unknown models must keep falling back to Sonnet rates (the conservative
// default the FAQ documents).

import { describe, it, expect } from "vitest";

import { estimateCostUsd, pricingFor } from "../src/shared/pricing.js";

describe("pricingFor", () => {
  it("resolves claude-fable-5 directly", () => {
    expect(pricingFor("claude-fable-5")).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheCreate: 12.5,
    });
  });

  it("resolves the [1m] long-context variant via the family match (the live case)", () => {
    expect(pricingFor("claude-fable-5[1m]")).toEqual(pricingFor("claude-fable-5"));
  });

  it("resolves an unseen point release to the newest known version below it", () => {
    expect(pricingFor("claude-opus-4-9")).toEqual(pricingFor("claude-opus-4-8"));
    expect(pricingFor("claude-opus-6")).toEqual(pricingFor("claude-opus-5-5"));
  });

  // v0.40.2 — every Opus was priced at Opus 4's $15/$75 and no 5.x model was
  // known, so an Opus 5.5 week read about 3.75× too high. These rows pin the
  // official prices (platform.claude.com pricing page, 2026-10-10).
  it("knows today's prices, including the 5.x models", () => {
    const io = (m: string) => {
      const x = pricingFor(m);
      return [x.input, x.output, x.cacheRead, x.cacheCreate];
    };
    expect(io("claude-opus-5-5")).toEqual([4, 20, 0.2, 5]);
    expect(io("claude-opus-5")).toEqual([5, 25, 0.5, 6.25]);
    expect(io("claude-opus-4-7[1m]")).toEqual([5, 25, 0.5, 6.25]);
    expect(io("claude-opus-4-1-20250805")).toEqual([15, 75, 1.5, 18.75]);
    expect(io("claude-sonnet-5-5")).toEqual([2, 10, 0.1, 2.5]);
    expect(io("claude-sonnet-5")).toEqual([2, 10, 0.2, 2.5]);
    expect(io("claude-sonnet-4-6")).toEqual([3, 15, 0.3, 3.75]);
    expect(io("claude-haiku-5-5")).toEqual([0.1, 0.5, 0.01, 0.125]);
    expect(io("claude-haiku-4-5-20251001")).toEqual([1, 5, 0.1, 1.25]);
    expect(io("claude-fable-5-1")).toEqual([10, 50, 0.25, 12.5]);
    expect(io("us.anthropic.claude-sonnet-4-6-v1:0")).toEqual([3, 15, 0.3, 3.75]);
  });

  it("falls back to Sonnet rates for unknown models and missing model", () => {
    const sonnet = pricingFor("claude-sonnet-4-6");
    expect(pricingFor("some-future-model")).toEqual(sonnet);
    expect(pricingFor(undefined)).toEqual(sonnet);
    expect(pricingFor(null)).toEqual(sonnet);
  });
});

describe("estimateCostUsd", () => {
  it("prices a Fable turn at $10/M in + $50/M out", () => {
    const cost = estimateCostUsd({
      model: "claude-fable-5[1m]",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(60, 5);
  });

  it("includes cache read/write at 0.1× and 1.25× the input rate", () => {
    const cost = estimateCostUsd({
      model: "claude-fable-5",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(13.5, 5); // $1 read + $12.50 write
  });

  it("prices Haiku 5.5 by prompt length, counting cache reads and writes", () => {
    const short = estimateCostUsd({
      model: "claude-haiku-5-5",
      input_tokens: 50_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 50_000,
    });
    // 50K in at $0.10 + 1M out at $0.50 + 50K read at $0.01
    expect(short).toBeCloseTo(0.005 + 0.5 + 0.0005, 6);
    const long = estimateCostUsd({
      model: "claude-haiku-5-5",
      input_tokens: 50_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 60_000,
    });
    // Over 100K together: $0.50 in, $2.50 out, $0.05 read
    expect(long).toBeCloseTo(0.025 + 2.5 + 0.003, 6);
  });

  it("prices an Opus 5.5 reply at its real rate", () => {
    expect(
      estimateCostUsd({
        model: "claude-opus-5-5",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBeCloseTo(24, 5);
  });
});
