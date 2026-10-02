// The /data payload budget. RecentTurns.svelte pages over recent_turns (25 per
// page), so every row is reachable: depth is a feature, not waste. This pins it
// so a later change can't quietly cut the table to a few pages.

import { describe, expect, it } from "vitest";

import { RECENT_TURNS_N } from "../src/dashboard/delta.js";

describe("dashboard payload budget", () => {
  it("keeps the paginated turn history deep", () => {
    // 60 here would have cut the table from 20 pages to 3.
    expect(RECENT_TURNS_N).toBeGreaterThanOrEqual(500);
  });
});
