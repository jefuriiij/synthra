// The activity watcher stays out of .git, .claude, .synthra and the like. It
// used glob patterns that chokidar 4+ no longer reads, so it watched every one
// of them: on Windows a watched folder can't be renamed, and archiving a
// project skill failed with EPERM.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileEvent } from "../src/activity/activity-log.js";
import { createFileWatcher, isAlwaysIgnored } from "../src/activity/file-watcher.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("isAlwaysIgnored", () => {
  it("judges the path below the root, folder by folder", () => {
    const root = join(tmpdir(), "build", "shop");
    for (const p of [".git", join(".claude", "skills", "x"), join("web", "node_modules", "y")]) {
      expect(isAlwaysIgnored(root, join(root, p)), p).toBe(true);
    }
    for (const p of ["src", join("src", "a.ts"), join("docs", "claude.md")]) {
      expect(isAlwaysIgnored(root, join(root, p)), p).toBe(false);
    }
    // The root sits in a folder named "build": still watched.
    expect(isAlwaysIgnored(root, root)).toBe(false);
  });
});

describe("the file watcher", () => {
  it("lets a skill folder move while it runs, and still sees edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-watch-"));
    await mkdir(join(root, ".claude", "skills", "deploy", "references"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "deploy", "SKILL.md"), "x", "utf8");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "1", "utf8");
    await mkdir(join(root, ".synthra", "skills-archive"), { recursive: true });

    const events: FileEvent[] = [];
    const w = createFileWatcher(root, (e) => {
      events.push(e);
    });
    await w.start();
    try {
      await wait(400);
      await rename(
        join(root, ".claude", "skills", "deploy"),
        join(root, ".synthra", "skills-archive", "deploy"),
      );
      await writeFile(join(root, "src", "a.ts"), "2", "utf8");
      for (let i = 0; i < 40 && !events.some((e) => e.path === "src/a.ts"); i++) await wait(100);
      expect(events.some((e) => e.kind === "save" && e.path === "src/a.ts")).toBe(true);
      expect(
        events.some((e) => e.path.startsWith(".claude") || e.path.startsWith(".synthra")),
      ).toBe(false);
    } finally {
      await w.stop();
    }
  }, 15_000);
});
