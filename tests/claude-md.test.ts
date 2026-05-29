import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { patchClaudeMd } from "../src/hooks/claude-md.js";

async function tmpClaudeMd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syn-cmd-"));
  return join(dir, "CLAUDE.md");
}

describe("patchClaudeMd onboarding skeleton", () => {
  it("scaffolds skeleton + policy block when no CLAUDE.md exists", async () => {
    const path = await tmpClaudeMd();
    const res = await patchClaudeMd(path, "my-proj");

    expect(res.created).toBe(true);
    const content = await readFile(path, "utf8");
    expect(content).toContain("# my-proj");
    expect(content).toContain("## Build & test");
    expect(content).toContain("## Key decisions");
    expect(content).toContain("synthra-policy v3 BEGIN");
    // Skeleton must come BEFORE the policy block.
    expect(content.indexOf("## Build & test")).toBeLessThan(
      content.indexOf("synthra-policy v3 BEGIN"),
    );
  });

  it("does NOT inject a skeleton into an existing CLAUDE.md", async () => {
    const path = await tmpClaudeMd();
    await writeFile(path, "# Existing user doc\n\nsome notes\n", "utf8");

    const res = await patchClaudeMd(path, "my-proj");

    expect(res.created).toBe(false);
    const content = await readFile(path, "utf8");
    expect(content).toContain("# Existing user doc");
    expect(content).not.toContain("## Build & test"); // no skeleton injected
    expect(content).toContain("synthra-policy v3 BEGIN"); // policy still appended
  });

  it("preserves the user's filled-in onboarding content across re-runs", async () => {
    const path = await tmpClaudeMd();
    await patchClaudeMd(path, "my-proj"); // first run scaffolds

    // User fills in a section.
    let content = await readFile(path, "utf8");
    content = content.replace("- TODO: install deps / build", "- npm install && npm run build");
    await writeFile(path, content, "utf8");

    // Second run: strips + re-adds the policy block. Must NOT touch the skeleton.
    await patchClaudeMd(path, "my-proj");

    const after = await readFile(path, "utf8");
    expect(after).toContain("- npm install && npm run build"); // user content survives
    const blocks = after.match(/synthra-policy v\d+ BEGIN/g) ?? [];
    expect(blocks.length).toBe(1); // exactly one policy block, no duplication
  });
});
