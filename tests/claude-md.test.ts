import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  POLICY_BEGIN,
  POLICY_VERSION,
  claudeStub,
  isSynthraOnlyClaudeMd,
  legacyOnboardingSkeleton,
  patchClaudeMd,
  policyBlock,
} from "../src/hooks/claude-md.js";

async function tmpClaudeMd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syn-cmd-"));
  return join(dir, "CLAUDE.md");
}

describe("patchClaudeMd: a short note, and the block imports AGENTS.md", () => {
  it("writes the note + policy block when no CLAUDE.md exists", async () => {
    const path = await tmpClaudeMd();
    const res = await patchClaudeMd(path, "my-proj");

    expect(res.created).toBe(true);
    const content = await readFile(path, "utf8");
    expect(content.startsWith(claudeStub("my-proj").trimEnd())).toBe(true);
    // The rules starter lives in AGENTS.md now, not here.
    expect(content).not.toContain("## Build & test");
    expect(content).toContain(`synthra-policy v${POLICY_VERSION} BEGIN`);
    expect(content).toContain("find_symbol"); // reuse-first nudge (v0.12)
    expect(content).toContain("route_task"); // delegate-first nudge (v0.16)
  });

  // Claude Code reads AGENTS.md by itself only without a CLAUDE.md, and Synthra
  // always writes one, so the import is what gets the rules to Claude.
  it("opens the block with an @AGENTS.md import on a line of its own", async () => {
    const path = await tmpClaudeMd();
    await patchClaudeMd(path, "p");
    const lines = (await readFile(path, "utf8")).split("\n");
    const begin = lines.indexOf(POLICY_BEGIN);
    const at = lines.indexOf("@AGENTS.md");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(begin);
    expect(at).toBeLessThan(lines.indexOf("## Synthra context policy"));
    expect(policyBlock({ importAgents: false })).not.toContain("@AGENTS.md");
  });

  it("does NOT add the note to an existing CLAUDE.md", async () => {
    const path = await tmpClaudeMd();
    await writeFile(path, "# Existing user doc\n\nsome notes\n", "utf8");

    const res = await patchClaudeMd(path, "my-proj");

    expect(res.created).toBe(false);
    const content = await readFile(path, "utf8");
    expect(content.startsWith("# Existing user doc\n\nsome notes\n\n")).toBe(true);
    expect(content).not.toContain("(Claude Code)");
    expect(content).toContain(`synthra-policy v${POLICY_VERSION} BEGIN`); // policy still appended
    expect(content).toContain("\n@AGENTS.md\n");
  });

  it("is idempotent: re-running makes no change (no blank-line creep)", async () => {
    const path = await tmpClaudeMd();
    await patchClaudeMd(path, "my-proj"); // create
    const first = await readFile(path, "utf8");

    const res = await patchClaudeMd(path, "my-proj"); // re-run, nothing changed
    const second = await readFile(path, "utf8");

    // Byte-identical: the policy block must not accumulate blank lines each
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

  // A 0.34 project: CLAUDE.md still holds the old starter, untouched. Its
  // prompts moved to AGENTS.md, so it becomes the note instead of a second copy.
  it("swaps the old untouched starter for the note, once", async () => {
    const path = await tmpClaudeMd();
    const v10 = "<!-- synthra-policy v10 BEGIN -->\nold\n<!-- synthra-policy v10 END -->\n";
    await writeFile(path, `${legacyOnboardingSkeleton("my-proj")}\n${v10}`, "utf8");

    expect((await patchClaudeMd(path, "my-proj")).updated).toBe(true);
    const content = await readFile(path, "utf8");
    expect(content.startsWith(claudeStub("my-proj").trimEnd())).toBe(true);
    expect(content).not.toContain("TODO");
    expect(content).toContain(`synthra-policy v${POLICY_VERSION} BEGIN`);
    expect((await patchClaudeMd(path, "my-proj")).skipped).toBe(true);
  });

  it("keeps an old starter the user filled in, exactly as it is", async () => {
    const path = await tmpClaudeMd();
    const filled = legacyOnboardingSkeleton("my-proj").replace(
      "- TODO: install deps / build",
      "- npm install && npm run build",
    );
    await writeFile(path, filled, "utf8");

    await patchClaudeMd(path, "my-proj");
    await patchClaudeMd(path, "my-proj");

    const after = await readFile(path, "utf8");
    expect(after.startsWith(filled.trimEnd())).toBe(true); // user content survives
    const blocks = after.match(/synthra-policy v\d+ BEGIN/g) ?? [];
    expect(blocks.length).toBe(1); // exactly one policy block, no duplication
  });

  it("knows a CLAUDE.md that holds only Synthra's own text", () => {
    const block = policyBlock();
    expect(isSynthraOnlyClaudeMd(`${claudeStub("p")}\n${block}\n`, "p")).toBe(true);
    expect(isSynthraOnlyClaudeMd(`${legacyOnboardingSkeleton("p")}\n${block}\n`, "p")).toBe(true);
    expect(isSynthraOnlyClaudeMd(`${block}\n`, "p")).toBe(true);
    expect(isSynthraOnlyClaudeMd(`# Rules\n\nUse tabs.\n\n${block}\n`, "p")).toBe(false);
  });
});

describe("patchClaudeMd policy (namespaced tools + reuse-first + delegate-first)", () => {
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
    expect(content).toContain(`synthra-policy v${POLICY_VERSION} BEGIN`);
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

describe("the Skills section: update first, create last", () => {
  const skills = () => {
    const block = policyBlock();
    return block.slice(block.indexOf("### Skills"), block.indexOf("_This block is managed"));
  };

  it("orders the steps and names a class, not a task", () => {
    const s = skills();
    for (const step of [
      "1. Patch the skill you used",
      "2. Patch an existing skill",
      "references/<topic>.md",
      "4. Only if nothing fits",
    ]) {
      expect(s).toContain(step);
    }
    expect(s).toContain("not `rail-travelling-light`");
    expect(s).toContain(".synthra/MEMORY.md");
  });

  // "A fix that took several tries" is how one skill per UI effect happened.
  it("no longer asks for a skill because a task was hard, and has no em dash", () => {
    expect(skills()).not.toMatch(/several tries/);
    expect(skills()).not.toContain(String.fromCharCode(0x2014));
  });
});
