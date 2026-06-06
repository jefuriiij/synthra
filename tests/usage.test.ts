// Usage-learning decay/aggregate core (pure).

import { describe, it, expect } from "vitest";

import {
  effectiveScores,
  foldEvent,
  emptyStore,
  recomputeFromLog,
  weightFor,
  type AccessEvent,
} from "../src/learn/usage.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T0_MS = Date.parse(T0);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const T_PLUS_HL = new Date(T0_MS + SEVEN_DAYS_MS).toISOString();

function ev(path: string, source: AccessEvent["source"], ts = T0): AccessEvent {
  return { ts, path, source };
}

describe("weightFor", () => {
  it("weights edits 2×, reads 1×, and continue 0", () => {
    expect(weightFor("register_edit")).toBe(2);
    expect(weightFor("read")).toBe(1);
    expect(weightFor("continue")).toBe(0);
  });
});

describe("foldEvent + effectiveScores", () => {
  it("a single read yields weight 1 at the event time", () => {
    const s = foldEvent(emptyStore(), ev("src/a.ts", "read"));
    expect(effectiveScores(s, T0_MS).get("src/a.ts")).toBeCloseTo(1, 5);
  });

  it("an edit is worth twice a read", () => {
    const s = emptyStore();
    foldEvent(s, ev("src/r.ts", "read"));
    foldEvent(s, ev("src/e.ts", "register_edit"));
    const m = effectiveScores(s, T0_MS);
    expect(m.get("src/e.ts")).toBeCloseTo(2, 5);
    expect(m.get("src/r.ts")).toBeCloseTo(1, 5);
  });

  it("ignores continue events and path-less events (no accrual)", () => {
    const s = emptyStore();
    foldEvent(s, ev("src/a.ts", "continue"));
    foldEvent(s, { ts: T0, path: "", source: "read" });
    expect(effectiveScores(s, T0_MS).size).toBe(0);
  });

  it("decays to ~half after one half-life", () => {
    const s = foldEvent(emptyStore(), ev("src/a.ts", "read"));
    expect(effectiveScores(s, T0_MS + SEVEN_DAYS_MS).get("src/a.ts")).toBeCloseTo(0.5, 3);
  });

  it("accumulates across events with decay applied between them", () => {
    const s = emptyStore();
    foldEvent(s, ev("src/a.ts", "read", T0)); // weight 1 @ T0
    foldEvent(s, ev("src/a.ts", "read", T_PLUS_HL)); // 1*0.5 + 1 = 1.5 @ T0+HL
    expect(effectiveScores(s, T0_MS + SEVEN_DAYS_MS).get("src/a.ts")).toBeCloseTo(1.5, 3);
  });

  it("an empty store yields an empty score map", () => {
    expect(effectiveScores(emptyStore(), T0_MS).size).toBe(0);
  });
});

describe("recomputeFromLog", () => {
  it("replaying the log equals incremental folding", () => {
    const events = [
      ev("src/a.ts", "read", T0),
      ev("src/b.ts", "register_edit", T0),
      ev("src/a.ts", "read", T_PLUS_HL),
      ev("", "continue", T_PLUS_HL),
    ];
    const replayed = recomputeFromLog(events);

    const incremental = emptyStore();
    for (const e of events) foldEvent(incremental, e);

    const now = T0_MS + SEVEN_DAYS_MS;
    const a = effectiveScores(replayed, now);
    const b = effectiveScores(incremental, now);
    expect(a.get("src/a.ts")).toBeCloseTo(b.get("src/a.ts") ?? -1, 6);
    expect(a.get("src/b.ts")).toBeCloseTo(b.get("src/b.ts") ?? -1, 6);
  });
});
