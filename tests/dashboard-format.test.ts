// Pure formatting/classification helpers for the Svelte dashboard. The
// components are verified via the vite build + live e2e; these helpers are the
// testable logic worth pinning.

import { describe, it, expect } from "vitest";
import {
  fmt,
  fmtCost,
  fmtTs,
  modelFamily,
  modelLabel,
  shortenPath,
} from "../src/dashboard/ui/lib/format.js";

describe("fmt", () => {
  it("abbreviates millions/thousands and rounds the rest", () => {
    expect(fmt(2_000_000)).toBe("2.0M");
    expect(fmt(3_400)).toBe("3.4k");
    expect(fmt(920)).toBe("920");
    expect(fmt(0)).toBe("0");
  });
  it("guards non-finite", () => {
    expect(fmt(Number.NaN)).toBe("0");
  });
});

describe("fmtCost", () => {
  it("formats USD with separators + 2 decimals", () => {
    expect(fmtCost(1234.5)).toBe("$1,234.50");
    expect(fmtCost(0)).toBe("$0.00");
  });
});

describe("fmtTs", () => {
  it("shows HH:MM for today and a short date otherwise", () => {
    const now = new Date();
    expect(fmtTs(now.toISOString())).toMatch(/^\d{1,2}:\d{2}/);
    expect(fmtTs("2020-01-02T03:04:05.000Z")).toMatch(/[A-Z][a-z]{2}/);
    expect(fmtTs("")).toBe("—");
  });
});

describe("modelFamily / modelLabel", () => {
  it("classifies by substring incl. the fable family", () => {
    expect(modelFamily("claude-fable-5[1m]")).toBe("fable");
    expect(modelFamily("claude-opus-4-8")).toBe("opus");
    expect(modelFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(modelFamily("claude-haiku-4-5")).toBe("haiku");
    expect(modelFamily("gpt-5")).toBe("unknown");
    expect(modelFamily(undefined)).toBe("unknown");
  });
  it("strips the claude- prefix", () => {
    expect(modelLabel("claude-opus-4-8")).toBe("opus-4-8");
    expect(modelLabel("<synthetic>")).toBe("synthetic");
  });
});

describe("shortenPath", () => {
  it("keeps the last two segments", () => {
    expect(shortenPath("src/dashboard/ui/App.svelte")).toBe("…/ui/App.svelte");
    expect(shortenPath("a/b")).toBe("a/b");
    expect(shortenPath("solo.ts")).toBe("solo.ts");
  });
});
