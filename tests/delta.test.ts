// Dashboard aggregation helpers.

import { describe, it, expect } from "vitest";

import { countToolCalls, topHotFiles } from "../src/dashboard/delta.js";
import { emptyStore, foldEvent } from "../src/learn/usage.js";

describe("countToolCalls (#2)", () => {
  it("counts Synthra MCP tool calls by name, ignoring empty entries", () => {
    const counts = countToolCalls([
      { tool: "graph_continue" },
      { tool: "graph_read" },
      { tool: "graph_read" },
      { tool: "" },
      { tool: "context_recall" },
    ]);
    expect(counts).toEqual({ graph_continue: 1, graph_read: 2, context_recall: 1 });
  });

  it("returns an empty object for no entries", () => {
    expect(countToolCalls([])).toEqual({});
  });
});

describe("topHotFiles (dashboard hot-files card)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const T0_MS = Date.parse(T0);
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  it("ranks files by decayed score (an edit outranks a read) and respects the limit", () => {
    const store = emptyStore();
    foldEvent(store, { ts: T0, path: "src/a.ts", source: "read" }); // weight 1
    foldEvent(store, { ts: T0, path: "src/b.ts", source: "read" }); // weight 1
    foldEvent(store, { ts: T0, path: "src/c.ts", source: "register_edit" }); // weight 2

    const top = topHotFiles(store, T0_MS);
    expect(top[0]?.path).toBe("src/c.ts");
    expect(top[0]?.score).toBeCloseTo(2, 5);
    expect(top.map((f) => f.path)).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);

    expect(topHotFiles(store, T0_MS, 2)).toHaveLength(2);
  });

  it("ranks a recently-used file above an equally-weighted stale one", () => {
    const store = emptyStore();
    foldEvent(store, { ts: T0, path: "src/old.ts", source: "read" }); // weight 1 @ T0
    foldEvent(store, {
      ts: new Date(T0_MS + SEVEN_DAYS_MS).toISOString(),
      path: "src/new.ts",
      source: "read",
    }); // weight 1 @ T0 + 1 half-life

    // Evaluated 7 days after T0: old.ts decayed to ~0.5, new.ts still ~1.0.
    const top = topHotFiles(store, T0_MS + SEVEN_DAYS_MS);
    expect(top[0]?.path).toBe("src/new.ts");
    const old = top.find((f) => f.path === "src/old.ts");
    expect(old?.score).toBeCloseTo(0.5, 1);
  });

  it("returns [] for an empty store", () => {
    expect(topHotFiles(emptyStore(), T0_MS)).toEqual([]);
  });
});
