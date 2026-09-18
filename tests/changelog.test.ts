import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { extractChangelogSection } from "../src/cli/self-update.js";

// `syn .` prints this section after an auto-update. A heading the extractor
// can't match means every user gets a silent "what changed?" on their next run,
// which is exactly the kind of thing that only shows up post-release.
describe("CHANGELOG is machine-readable", () => {
  const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

  it("exposes the current and recent versions to the self-update printer", () => {
    for (const v of ["0.31.0", "0.30.2", "0.30.0"]) {
      const section = extractChangelogSection(md, v);
      expect(section, `${v} section should be extractable`).toBeTruthy();
      expect(section!.split("\n").length).toBeGreaterThan(3);
    }
  });

  it("matches the version in package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(extractChangelogSection(md, pkg.version)).toBeTruthy();
  });
});
