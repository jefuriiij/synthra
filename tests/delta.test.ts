// Dashboard aggregation helpers.

import { describe, it, expect } from "vitest";

import {
  correlateFollows,
  countBypassedBlocks,
  countToolCalls,
  summarizeRoutes,
} from "../src/dashboard/delta.js";
import type {
  BashLogEntry,
  DelegationLogEntry,
  GateLogEntry,
  RouteLogEntry,
} from "../src/dashboard/delta.js";

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

describe("summarizeRoutes (dashboard Dispatcher card, v0.19)", () => {
  const route = (over: Partial<RouteLogEntry>): RouteLogEntry => ({
    ts: "2026-07-03T00:00:00.000Z",
    prompt: "x",
    routed: false,
    hint_chars: 0,
    difficulty: "standard",
    ...over,
  });

  it("counts totals, hints, complex verdicts, and per-agent recommendations", () => {
    const s = summarizeRoutes([
      route({ routed: true, agent: "svelte-file-editor", model: "sonnet" }),
      route({ routed: true, difficulty: "complex", agent: "socket-debugger", model: "opus" }),
      route({ routed: true, agent: "svelte-file-editor", model: "sonnet" }),
      route({}), // silent, standard, no agent
    ]);
    expect(s).toEqual({
      total: 4,
      hinted: 3,
      // pre-v0.21 entries have no `matched` — `routed` stands in for it
      matched: 3,
      complex: 1,
      agents: { "svelte-file-editor": 2, "socket-debugger": 1 },
    });
  });

  it("separates shadow verdicts (matched) from injected ones (routed) — v0.21", () => {
    const s = summarizeRoutes([
      // shadow mode: scorer confident, nothing injected
      route({ routed: false, matched: true, agent: "svelte-file-editor" }),
      route({ routed: false, matched: true, agent: "socket-debugger" }),
      // no match at all
      route({ routed: false, matched: false }),
      // injection re-enabled for this one
      route({ routed: true, matched: true, agent: "svelte-file-editor" }),
    ]);
    expect(s.total).toBe(4);
    expect(s.matched).toBe(3);
    expect(s.hinted).toBe(1);
    expect(s.agents).toEqual({ "svelte-file-editor": 2, "socket-debugger": 1 });
  });

  it("tolerates pre-v0.19 entries without agent/model fields", () => {
    const s = summarizeRoutes([route({ routed: true }), route({ difficulty: "complex" })]);
    expect(s.agents).toEqual({});
    expect(s.total).toBe(2);
    expect(s.hinted).toBe(1);
    expect(s.complex).toBe(1);
  });

  it("returns zeros for an empty (or absent) log", () => {
    expect(summarizeRoutes([])).toEqual({
      total: 0,
      hinted: 0,
      matched: 0,
      complex: 0,
      agents: {},
    });
  });
});

describe("correlateFollows (Dispatcher follow-rate, v0.20)", () => {
  const T = (min: number) => new Date(Date.UTC(2026, 6, 15, 10, min)).toISOString();
  const hint = (min: number, agent?: string): RouteLogEntry => ({
    ts: T(min),
    prompt: "x",
    routed: true,
    hint_chars: 100,
    difficulty: "standard",
    ...(agent ? { agent, model: "sonnet" } : {}),
  });
  const dele = (min: number, agent?: string): DelegationLogEntry => ({
    ts: T(min),
    agent: agent ?? null,
  });

  it("counts a delegation inside the 30-min window as followed; exact when agents match", () => {
    const r = correlateFollows([hint(0, "svelte-file-editor")], [dele(10, "svelte-file-editor")]);
    expect(r).toEqual({ hints: 1, followed: 1, followed_agent: 1 });
  });

  it("a delegation outside the window, or before the hint, does not count", () => {
    expect(correlateFollows([hint(0)], [dele(45)]).followed).toBe(0);
    expect(correlateFollows([hint(30)], [dele(10)]).followed).toBe(0);
  });

  it("the next hint cuts the window short", () => {
    // Delegation at minute 20 falls after hint #2 (minute 15), so it belongs
    // to hint #2 — hint #1's window ended at 15.
    const r = correlateFollows([hint(0, "a"), hint(15, "b")], [dele(20, "b")]);
    expect(r).toEqual({ hints: 2, followed: 1, followed_agent: 1 });
  });

  it("a different agent still counts as followed, not exact", () => {
    const r = correlateFollows([hint(0, "svelte-file-editor")], [dele(5, "general-purpose")]);
    expect(r).toEqual({ hints: 1, followed: 1, followed_agent: 0 });
  });

  it("silent routes and empty logs yield zeros", () => {
    const silent: RouteLogEntry = {
      ts: T(0),
      prompt: "x",
      routed: false,
      hint_chars: 0,
      difficulty: "standard",
    };
    expect(correlateFollows([silent], [dele(1)])).toEqual({
      hints: 0,
      followed: 0,
      followed_agent: 0,
    });
    expect(correlateFollows([], [])).toEqual({ hints: 0, followed: 0, followed_agent: 0 });
  });
});

describe("countBypassedBlocks (Moat false-block signal, v0.20)", () => {
  const T = (sec: number) => new Date(Date.UTC(2026, 6, 15, 10, 0, sec)).toISOString();
  const block = (sec: number, query: string): GateLogEntry => ({
    ts: T(sec),
    tool: "Grep",
    decision: "block",
    query,
  });
  const search = (sec: number, query: string, command = ""): BashLogEntry => ({
    ts: T(sec),
    kind: "search",
    tool: "rg",
    query,
    confidence: "medium",
    avoidable: false,
    ...(command ? { command } : {}),
  });

  it("counts a token-overlapping terminal search within 120s as a bypass", () => {
    const r = countBypassedBlocks(
      [block(0, "activeStep = |STEP_MS")],
      [search(30, "activeStep", "rg 'activeStep' src/")],
    );
    expect(r).toEqual({ blocks: 1, bypassed: 1 });
  });

  it("no bypass when the search is late or shares no tokens", () => {
    expect(
      countBypassedBlocks([block(0, "activeStep")], [search(180, "activeStep")]).bypassed,
    ).toBe(0);
    expect(countBypassedBlocks([block(0, "activeStep")], [search(30, "menuOpen")]).bypassed).toBe(
      0,
    );
  });

  it("matches on the raw command text too, and ignores non-search bash entries", () => {
    const read: BashLogEntry = {
      ts: T(10),
      kind: "read",
      tool: "cat",
      query: "src/activeStep.ts",
      confidence: null,
      avoidable: false,
    };
    expect(
      countBypassedBlocks(
        [block(0, "dispatchLessonPatch")],
        [read, search(20, null as unknown as string, "rg dispatchLessonPatch src")],
      ),
    ).toEqual({ blocks: 1, bypassed: 1 });
  });

  it("allow decisions are never counted", () => {
    const allow: GateLogEntry = { ts: T(0), tool: "Grep", decision: "allow", query: "x" };
    expect(countBypassedBlocks([allow], [search(5, "x")])).toEqual({ blocks: 0, bypassed: 0 });
  });
});
