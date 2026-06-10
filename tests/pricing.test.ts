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

  it("resolves unseen family versions via the loose match (opus)", () => {
    expect(pricingFor("claude-opus-4-8")).toEqual(pricingFor("claude-opus-4-7"));
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
});
