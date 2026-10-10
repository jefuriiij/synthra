// v0.41: `syn codex` on 0.40.4 (no such command yet) made an empty `codex/`
// folder and set Synthra up in it: any unknown word became a new project.
// `syn <folder>`, scan, serve and dashboard now refuse a folder that isn't
// there, and create nothing.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { folderProblem, requireFolder } from "../src/cli/require-folder.js";

afterEach(() => {
  process.exitCode = undefined;
});

describe("syn won't make a project folder that isn't there", () => {
  it("accepts an existing folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-folder-"));
    expect(await folderProblem(dir)).toBeNull();
    expect(await requireFolder(dir)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a missing folder, says so, and creates nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-folder-"));
    const missing = join(dir, "codex");
    expect(await folderProblem(missing)).toContain("No folder named");
    expect(await requireFolder(missing)).toBe(false);
    expect(process.exitCode).toBe(1);
    await expect(stat(missing)).rejects.toThrow();
  });

  it("refuses a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-folder-"));
    const file = join(dir, "notes.txt");
    await writeFile(file, "x");
    expect(await folderProblem(file)).toContain("is a file, not a folder");
  });
});
