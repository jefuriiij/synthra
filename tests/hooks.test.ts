// Bash hooks must parse JSON with jq behind a guard, never a greedy sed capture
// (the bug fixed across stop/prime in #1 and pre-compact here).

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SCRIPTS = join(process.cwd(), "src", "hooks", "scripts");

describe("pre-compact.sh jq parity", () => {
  it("parses the primer with jq behind a `command -v jq` guard (no sed capture)", async () => {
    const sh = await readFile(join(SCRIPTS, "pre-compact.sh"), "utf8");
    expect(sh).toContain("command -v jq");
    expect(sh).toContain("jq -r '.primer // empty'");
    // The greedy sed capture must be gone.
    expect(sh).not.toMatch(/sed -n 's\/.*"primer"/);
  });
});
