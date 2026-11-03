// v0.47 (Radar R-045): Claude Code cuts a PreCompact hook's output at 10,000
// characters (2.1.314), and the bash hooks cut the primer at a byte count,
// anywhere, even mid-character. A real project's primer measured 7,848 bytes,
// near the old 8,000-byte cut. The server now fits the primer itself.

import { describe, expect, it } from "vitest";

import { fitPrimer, PRIMER_MAX_BYTES } from "../src/server/routes/prime.js";

const lines = (label: string, n: number, width = 60) =>
  Array.from({ length: n }, (_, i) => `- ${label} ${i} ${"x".repeat(width)}`).join("\n");
const size = (t: string) => Buffer.byteLength(t, "utf8");

describe("fitting the primer", () => {
  it("leaves a primer that fits as it is", () => {
    const out = fitPrimer("## Since you were last here\n- a", "## Project memory\n- b", "Synthra.");
    expect(out).toBe(
      "## Since you were last here\n- a\n\n---\n\n## Project memory\n- b\n\n---\n\nSynthra.",
    );
  });

  it("trims the resume digest first, by whole lines, and keeps the memory whole", () => {
    const digest = `## Since you were last here\n${lines("file", 120)}`;
    const knowledge = `## Project memory\n${lines("fact", 60)}`;
    const out = fitPrimer(digest, knowledge, "Synthra context loaded.");
    expect(size(out)).toBeLessThanOrEqual(PRIMER_MAX_BYTES);
    expect(out).toContain(knowledge);
    expect(out).toContain("## Since you were last here");
    expect(out).toContain("Synthra shortened this");
    // Whole lines only: every digest line kept is complete.
    for (const l of out.split("\n").filter((x) => x.startsWith("- file"))) {
      expect(l).toMatch(/^- file \d+ x{60}$/);
    }
  });

  it("cuts the memory only when it alone is too big, and still says so", () => {
    const knowledge = `## Project memory\n${lines("fact", 400)}`;
    const out = fitPrimer("## Since you were last here\n- a", knowledge, "Synthra.");
    expect(size(out)).toBeLessThanOrEqual(PRIMER_MAX_BYTES);
    expect(out).toContain("Synthra shortened this");
    expect(out).toContain("- fact 0 ");
    expect(out.endsWith("Synthra.")).toBe(true);
  });

  it("counts bytes, not characters, so a multi-byte text can't overflow the bash cut", () => {
    const wide = Array.from({ length: 400 }, (_, i) => `- ${i} ${"é".repeat(30)}`).join("\n");
    const out = fitPrimer(wide, "## Project memory\n- b", "Synthra.");
    expect(out.length).toBeLessThan(size(out));
    expect(size(out)).toBeLessThanOrEqual(PRIMER_MAX_BYTES);
  });
});
