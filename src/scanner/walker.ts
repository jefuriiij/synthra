// Walks project root, yields files to parse.
// Honors .gitignore + .synthraignore (additive — entries in either are ignored).
// Defensive defaults skip VCS, build, and dependency directories even if absent
// from .gitignore.

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

export interface WalkedFile {
  absPath: string;
  relPath: string;
  ext: string;
  size: number;
}

export interface WalkOptions {
  /** Maximum file size to yield (bytes). Defaults to 2 MB. */
  maxFileSize?: number;
  /** Additional ignore patterns layered on top of .gitignore + .synthraignore. */
  extraIgnore?: string[];
}

const DEFAULT_IGNORE = [
  ".git/",
  ".synthra/",
  ".synthra-graph/",
  ".claude/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  ".vscode/",
  ".idea/",
];

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".ogg",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".lock", ".lockb",
]);

async function readIgnoreFile(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

async function buildMatcher(root: string, extra: string[]): Promise<Ignore> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE);
  ig.add(await readIgnoreFile(join(root, ".gitignore")));
  ig.add(await readIgnoreFile(join(root, ".synthraignore")));
  if (extra.length) ig.add(extra);
  return ig;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export async function* walk(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkedFile> {
  const maxFileSize = options.maxFileSize ?? 2_000_000;
  const ig = await buildMatcher(root, options.extraIgnore ?? []);

  async function* recurse(dir: string): AsyncGenerator<WalkedFile> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (!rel) continue;
      const relPosix = toPosix(rel);
      const matchPath = entry.isDirectory() ? `${relPosix}/` : relPosix;
      if (ig.ignores(matchPath)) continue;

      if (entry.isDirectory()) {
        yield* recurse(abs);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        let size: number;
        try {
          const s = await stat(abs);
          size = s.size;
        } catch {
          continue;
        }
        if (size > maxFileSize) continue;
        yield { absPath: abs, relPath: relPosix, ext, size };
      }
    }
  }

  yield* recurse(root);
}
