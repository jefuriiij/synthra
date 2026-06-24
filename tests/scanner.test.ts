// Walker tests — the filesystem traversal that feeds the scanner. Covers
// .gitignore / .synthraignore / DEFAULT_IGNORE / extraIgnore, binary-ext skip,
// and the maxFileSize cap.

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { walk, type WalkOptions } from "../src/scanner/walker.js";

// Materialize a temp project from a { relPath: content } map.
async function tmpProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "syn-walk-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

async function walkRel(root: string, opts?: WalkOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walk(root, opts)) out.push(f.relPath);
  return out.sort();
}

describe("walk", () => {
  it("yields files with POSIX relPath, ext, and size", async () => {
    const root = await tmpProject({
      "src/a.ts": "export const a = 1;\n",
      "src/sub/b.py": "x = 1\n",
      "README.md": "# hi\n",
    });

    const out = new Map<string, { ext: string; size: number; relPath: string }>();
    for await (const f of walk(root))
      out.set(f.relPath, { ext: f.ext, size: f.size, relPath: f.relPath });

    expect([...out.keys()].sort()).toEqual(["README.md", "src/a.ts", "src/sub/b.py"]);
    expect(out.get("src/a.ts")?.ext).toBe(".ts");
    expect(out.get("src/a.ts")?.size).toBeGreaterThan(0);
    // relPath is POSIX-normalized even on Windows.
    expect(out.get("src/sub/b.py")?.relPath).toBe("src/sub/b.py");
  });

  it("respects .gitignore (file + dir patterns)", async () => {
    const root = await tmpProject({
      ".gitignore": "ignored/\nsecret.ts\n",
      "keep.ts": "1",
      "secret.ts": "1",
      "ignored/x.ts": "1",
    });
    const out = await walkRel(root);
    expect(out).toContain("keep.ts");
    expect(out).not.toContain("secret.ts");
    expect(out).not.toContain("ignored/x.ts");
  });

  it("respects .synthraignore (merged with .gitignore)", async () => {
    const root = await tmpProject({
      ".synthraignore": "generated/\n",
      "keep.ts": "1",
      "generated/g.ts": "1",
    });
    const out = await walkRel(root);
    expect(out).toContain("keep.ts");
    expect(out).not.toContain("generated/g.ts");
  });

  it("skips DEFAULT_IGNORE dirs with no ignore file present", async () => {
    const root = await tmpProject({
      "keep.ts": "1",
      "node_modules/dep/index.ts": "1",
      "dist/out.js": "1",
    });
    expect(await walkRel(root)).toEqual(["keep.ts"]);
  });

  it("honors the extraIgnore option", async () => {
    const root = await tmpProject({
      "keep.ts": "1",
      "scratch/tmp.ts": "1",
    });
    const out = await walkRel(root, { extraIgnore: ["scratch/"] });
    expect(out).toContain("keep.ts");
    expect(out).not.toContain("scratch/tmp.ts");
  });

  it("skips binary file extensions", async () => {
    const root = await tmpProject({
      "code.ts": "1",
      "logo.png": "not-really-binary",
    });
    expect(await walkRel(root)).toEqual(["code.ts"]);
  });

  it("skips files larger than maxFileSize", async () => {
    const root = await tmpProject({
      "small.ts": "x",
      "big.ts": "x".repeat(5000),
    });
    const out = await walkRel(root, { maxFileSize: 1000 });
    expect(out).toContain("small.ts");
    expect(out).not.toContain("big.ts");
  });

  it("skips minified / bundle files (no readable symbols)", async () => {
    const root = await tmpProject({
      "src/app.ts": "export const a = 1;\n",
      "lib.js": "export const b = 2;\n", // real source — kept
      "static/js/bootstrap.min.js": "/*min*/",
      "vendor/swiper.bundle.min.js": "/*min*/", // ends .min.js → matched
      "app.bundle.js": "/*bundle*/",
      "jquery-min.js": "/*min*/",
      "theme.min.css": ".a{color:red}",
    });
    const out = await walkRel(root);
    expect(out).toEqual(["lib.js", "src/app.ts"]);
  });
});
