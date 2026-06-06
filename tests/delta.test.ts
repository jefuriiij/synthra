// Dashboard aggregation helpers.

import { describe, it, expect } from "vitest";

import { countToolCalls } from "../src/dashboard/delta.js";

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
