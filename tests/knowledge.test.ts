// The two knowledge files every AI reads first (src/memory/knowledge.ts):
// .synthra/MEMORY.md and ~/.synthra/USER.md. Plain Markdown bullets, a hard
// character limit, and hand edits by other agents must survive.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyOps,
  charCount,
  cleanEntry,
  knowledgeHeader,
  knowledgeSection,
  parseKnowledge,
  readKnowledge,
  updateKnowledge,
} from "../src/memory/knowledge.js";

async function tmpFile(name = "MEMORY.md"): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "syn-knowledge-")), ".synthra", name);
}

describe("parseKnowledge", () => {
  it("reads bullets and keeps whatever sits above them", () => {
    const text = "# Project memory\n\nA note a human wrote.\n\n- First fact\n- Second fact\n";
    const p = parseKnowledge(text);
    expect(p.preamble).toBe("# Project memory\n\nA note a human wrote.\n");
    expect(p.entries).toEqual(["First fact", "Second fact"]);
  });

  // Another agent editing by hand may wrap a bullet, or drop a paragraph in.
  it("folds wrapped and stray lines into the bullet above, losing nothing", () => {
    const p = parseKnowledge(
      "- Build with npm run build\n  then npm test\nA stray line\n* Star bullet\n",
    );
    expect(p.entries).toEqual([
      "Build with npm run build\nthen npm test\nA stray line",
      "Star bullet",
    ]);
  });

  it("has no entries in a file without bullets", () => {
    expect(parseKnowledge("# Project memory\n").entries).toEqual([]);
  });
});

describe("cleanEntry", () => {
  it("strips a leading bullet and whitespace", () => {
    expect(cleanEntry("  - Use pnpm, not npm  ")).toEqual({ text: "Use pnpm, not npm" });
  });

  it("refuses empty text, comment markers and invisible characters", () => {
    expect(cleanEntry("   ")).toHaveProperty("error");
    expect(cleanEntry("a <!-- b")).toHaveProperty("error");
    expect(cleanEntry("hidden​text")).toHaveProperty("error");
  });

  // MEMORY.md is committed: a key saved there is a key published.
  it("refuses things that look like secrets", () => {
    for (const s of [
      "The key is sk-abcdefghijklmnopqrstuvwxyz123456",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "password = hunter2hunter2",
      "-----BEGIN RSA PRIVATE KEY-----",
    ]) {
      expect(cleanEntry(s), s).toHaveProperty("error");
    }
    expect(cleanEntry("Tokens expire after 15 minutes")).toEqual({
      text: "Tokens expire after 15 minutes",
    });
  });
});

describe("applyOps", () => {
  const base = ["Use pnpm, not npm", "Tests run with vitest", "The API lives in src/server"];

  it("adds, replaces by a unique piece, and removes", () => {
    const r = applyOps(
      base,
      [
        { action: "add", content: "Deploy with fly deploy" },
        {
          action: "replace",
          old_text: "vitest",
          content: "Tests run with vitest; use --run in CI",
        },
        { action: "remove", old_text: "src/server" },
      ],
      3500,
    );
    expect(r).toEqual({
      entries: [
        "Use pnpm, not npm",
        "Tests run with vitest; use --run in CI",
        "Deploy with fly deploy",
      ],
    });
  });

  it("refuses an ambiguous or missing match, and a duplicate add", () => {
    expect(applyOps(base, [{ action: "remove", old_text: "s" }], 3500)).toHaveProperty("error");
    expect(
      applyOps(base, [{ action: "remove", old_text: "nothing like it" }], 3500),
    ).toHaveProperty("error");
    expect(applyOps(base, [{ action: "add", content: "Use pnpm, not npm" }], 3500)).toHaveProperty(
      "error",
    );
  });

  it("prefers an exact match over longer entries that contain it", () => {
    const r = applyOps(
      ["deploy", "deploy with fly"],
      [{ action: "remove", old_text: "deploy" }],
      99,
    );
    expect(r).toEqual({ entries: ["deploy with fly"] });
  });

  it("refuses to grow past the limit, and says how to make room", () => {
    const r = applyOps(base, [{ action: "add", content: "x".repeat(40) }], charCount(base) + 10);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/Consolidate/);
  });

  // Consolidation is several changes at once: checked against the final size.
  it("checks a batch against its final size, not each step", () => {
    const limit = charCount(base) + 5;
    const r = applyOps(
      base,
      [
        { action: "remove", old_text: "src/server" },
        { action: "add", content: "API: src/server" },
      ],
      limit,
    );
    expect(r).toHaveProperty("entries");
  });

  it("always lets a file that is over its limit shrink", () => {
    const r = applyOps(base, [{ action: "remove", old_text: "pnpm" }], 5);
    expect(r).toEqual({ entries: ["Tests run with vitest", "The API lives in src/server"] });
  });
});

describe("updateKnowledge", () => {
  it("creates the file with its header on the first add", async () => {
    const path = await tmpFile();
    const r = await updateKnowledge(
      "project",
      path,
      [{ action: "add", content: "Use pnpm" }],
      3500,
    );
    expect(r.ok).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text.startsWith(knowledgeHeader("project", 3500))).toBe(true);
    expect(text.endsWith("- Use pnpm\n")).toBe(true);
  });

  it("keeps a human's text above the list when it rewrites the bullets", async () => {
    const path = await tmpFile();
    await updateKnowledge("project", path, [{ action: "add", content: "one" }], 3500);
    await writeFile(path, "# Our notes\n\nRead this first.\n\n- one\n", "utf8");
    await updateKnowledge(
      "project",
      path,
      [{ action: "add", content: "two\nwith a second line" }],
      3500,
    );
    expect(await readFile(path, "utf8")).toBe(
      "# Our notes\n\nRead this first.\n\n- one\n- two\n  with a second line\n",
    );
    const f = await readKnowledge("project", path, 3500);
    expect(f.entries).toEqual(["one", "two\nwith a second line"]);
  });

  it("leaves the file untouched and reports the current entries on an error", async () => {
    const path = await tmpFile();
    await updateKnowledge("project", path, [{ action: "add", content: "keep me" }], 20);
    const before = await readFile(path, "utf8");
    const r = await updateKnowledge(
      "project",
      path,
      [{ action: "add", content: "x".repeat(30) }],
      20,
    );
    expect(r.ok).toBe(false);
    expect(r.file.entries).toEqual(["keep me"]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("reads a missing file as empty", async () => {
    const f = await readKnowledge("user", await tmpFile("USER.md"), 2000);
    expect(f).toMatchObject({ exists: false, entries: [], chars: 0, limit: 2000 });
  });
});

describe("knowledgeSection (the primer)", () => {
  const file = (entries: string[], limit: number) => ({
    target: "project" as const,
    path: "/p/.synthra/MEMORY.md",
    exists: true,
    entries,
    chars: charCount(entries),
    limit,
  });

  it("shows the bullets with how full the file is", () => {
    expect(
      knowledgeSection(file(["a", "b"], 3500), "Project memory", ".synthra/MEMORY.md"),
    ).toEqual(["## Project memory (.synthra/MEMORY.md · 3/3,500 chars)", "- a", "- b"]);
  });

  it("is empty for an empty file", () => {
    expect(knowledgeSection(file([], 3500), "Project memory", "x")).toEqual([]);
  });

  it("says when the file is over its limit, and cuts a runaway one", () => {
    const lines = knowledgeSection(file(["x".repeat(30), "y".repeat(30)], 20), "T", "x");
    expect(lines[1]).toMatch(/Over its limit/);
    expect(lines.at(-1)).toMatch(/cut/);
  });
});
