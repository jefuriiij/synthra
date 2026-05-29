import { describe, it, expect } from "vitest";

import { extractChangelogSection } from "../src/cli/self-update.js";

const CHANGELOG = `# Synthra changelog

Some preamble.

---

## [0.1.11] — 2026-05-29

### Fixed

- Bullet A
- Bullet B

### Changed

- Bullet C

---

## [0.1.10] — 2026-05-29

### Changed

- Older bullet
`;

describe("extractChangelogSection", () => {
  it("returns the bullets/prose under a bracketed version heading", () => {
    const section = extractChangelogSection(CHANGELOG, "0.1.11");
    expect(section).not.toBeNull();
    expect(section).toContain("Bullet A");
    expect(section).toContain("Bullet B");
    expect(section).toContain("Bullet C");
    expect(section).not.toContain("Older bullet");
    expect(section).not.toContain("---");
  });

  it("returns null when the version isn't present", () => {
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("matches `## v0.1.11` form too (no brackets)", () => {
    const variant = CHANGELOG.replace("## [0.1.11] — 2026-05-29", "## v0.1.11 (2026-05-29)");
    const section = extractChangelogSection(variant, "0.1.11");
    expect(section).not.toBeNull();
    expect(section).toContain("Bullet A");
  });

  it("matches the last section even without a trailing heading", () => {
    const trimmed = CHANGELOG.split("## [0.1.10]")[0]!;
    const section = extractChangelogSection(trimmed, "0.1.11");
    expect(section).toContain("Bullet C");
  });
});
