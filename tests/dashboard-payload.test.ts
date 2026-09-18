// The /data payload budget.
//
// Four recent_* arrays were 96% of a 483 KB payload polled every 10s. But they
// are not equivalent: RecentTurns.svelte PAGINATES over recent_turns (25/page),
// so every row is reachable and none of it is waste. The other three are hard
// -sliced on arrival — Moat.svelte takes 50 gates and 12 bash, Dispatcher.svelte
// takes 50 routes — so everything past those bounds is shipped and discarded.
//
// These tests pin that distinction so a future change can't silently truncate
// the paginated history or re-inflate the capped feeds.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { RECENT_FEED_N, RECENT_TURNS_N } from "../src/dashboard/delta.js";

const UI = join(import.meta.dirname, "..", "src", "dashboard", "ui");

describe("dashboard payload budget", () => {
  it("caps the hard-sliced feeds just above what the UI renders", () => {
    // Moat slices gates to 50; Dispatcher slices routes to 50. Anything beyond
    // is unreachable, so the budget only needs headroom over the largest slice.
    expect(RECENT_FEED_N).toBeGreaterThanOrEqual(50);
    expect(RECENT_FEED_N).toBeLessThanOrEqual(100);
  });

  it("keeps the paginated turn history deep", () => {
    // Every turn IS reachable by paging, so this is a feature, not waste.
    // 60 here would have cut the table from 20 pages to 3.
    expect(RECENT_TURNS_N).toBeGreaterThanOrEqual(500);
  });

  it("budgets the feeds well below the turns history", () => {
    expect(RECENT_FEED_N).toBeLessThan(RECENT_TURNS_N);
  });

  // Guards the premise above: if someone raises a slice past the feed budget,
  // the UI would render a silently-truncated list. Fail here instead.
  it("no component slices a feed deeper than the feed budget", async () => {
    const sources = await Promise.all(
      ["Moat.svelte", "Dispatcher.svelte"].map((f) => readFile(join(UI, f), "utf8")),
    );
    const slices = sources
      .join("\n")
      .matchAll(/recent_(gates|bash|routes)\s*\?\?\s*\[\]\)\.slice\(0,\s*(\d+)\)/g);
    const found = [...slices].map((m) => Number(m[2]));
    expect(found.length).toBeGreaterThan(0); // the regex must actually match
    for (const n of found) expect(n).toBeLessThanOrEqual(RECENT_FEED_N);
  });
});
