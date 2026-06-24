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
    expect(content).toContain("synthra-policy v8 BEGIN");
    expect(content).toContain("find_symbol"); // reuse-first nudge (v0.12)
    // Skeleton must come BEFORE the policy block.
    expect(content.indexOf("## Build & test")).toBeLessThan(
      content.indexOf("synthra-policy v8 BEGIN"),
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
    expect(content).toContain("synthra-policy v8 BEGIN"); // policy still appended
  });

  it("is idempotent: re-running makes no change (no blank-line creep)", async () => {
    const path = await tmpClaudeMd();
    await patchClaudeMd(path, "my-proj"); // create
    const first = await readFile(path, "utf8");

    const res = await patchClaudeMd(path, "my-proj"); // re-run, nothing changed
    const second = await readFile(path, "utf8");

    // Byte-identical — the policy block must not accumulate blank lines each
    // run (the bug that turned auto-reindex into an endless CLAUDE.md rewrite).
    expect(second).toBe(first);
    expect(res.skipped).toBe(true);
    expect(res.updated).toBe(false);
  });

  it("is idempotent against an existing doc with no prior block", async () => {
    const path = await tmpClaudeMd();
    await writeFile(path, "# Existing user doc\n\nsome notes\n", "utf8");

    await patchClaudeMd(path, "p"); // appends block
    const first = await readFile(path, "utf8");
    const res = await patchClaudeMd(path, "p"); // re-run is a no-op
    expect(await readFile(path, "utf8")).toBe(first);
    expect(res.skipped).toBe(true);
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

describe("patchClaudeMd policy v8 (namespaced tools + reuse-first)", () => {
  it("strips a prior v6 block and installs the current block with full tool names + loader line", async () => {
    const path = await tmpClaudeMd();
    await writeFile(
      path,
      "# Doc\n\n<!-- synthra-policy v6 BEGIN -->\nold policy\n<!-- synthra-policy v6 END -->\n",
      "utf8",
    );

    const res = await patchClaudeMd(path, "p");
    expect(res.updated).toBe(true);

    const content = await readFile(path, "utf8");
    expect(content).toContain("synthra-policy v8 BEGIN");
    expect(content).not.toContain("synthra-policy v6 BEGIN");
    expect(content).toContain("### Resuming a session");
    expect(content).toContain("Since you were last here");
    // v7: the ToolSearch loader line + full-form invocation examples — the
    // dogfood failure was Claude ToolSearching short names and finding nothing.
    expect(content).toContain(
      "select:mcp__synthra__graph_continue,mcp__synthra__graph_read,mcp__synthra__graph_register_edit",
    );
    expect(content).toContain('mcp__synthra__graph_read("file.ts::symbol")');
    expect(content).toContain('mcp__synthra__context_recall({kind:"next"})');
    // The user's prose is preserved; exactly one managed block remains.
    expect(content).toContain("# Doc");
    expect((content.match(/synthra-policy v\d+ BEGIN/g) ?? []).length).toBe(1);
  });
});
