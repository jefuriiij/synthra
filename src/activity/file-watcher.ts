// chokidar-based file watcher. Emits save/create/delete events for human
// edits inside the project. Respects .gitignore + .synthraignore plus a
// hard-coded list of always-ignored directories (.git, .synthra*, .claude,
// node_modules, dist, build, coverage).

import chokidar, { type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

import { log } from "../shared/logger.js";
import type { FileEvent } from "./activity-log.js";

const ALWAYS_IGNORE = [
  ".git",
  ".synthra",
  ".synthra-graph",
  ".claude",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".vscode",
  ".idea",
];

export interface FileWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type FileEventHandler = (e: FileEvent) => void | Promise<void>;

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

async function buildMatcher(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(ALWAYS_IGNORE.map((d) => `${d}/`));
  ig.add(await readIgnoreFile(join(root, ".gitignore")));
  ig.add(await readIgnoreFile(join(root, ".synthraignore")));
  return ig;
}

function toPosixRel(root: string, abs: string): string {
  const rel = relative(root, abs);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

export function createFileWatcher(root: string, onEvent: FileEventHandler): FileWatcher {
  let watcher: FSWatcher | null = null;
  let ig: Ignore | null = null;

  const emit = async (kind: FileEvent["kind"], abs: string) => {
    if (!ig) return;
    const rel = toPosixRel(root, abs);
    if (!rel || rel.startsWith("..")) return;
    if (ig.ignores(rel)) return;
    try {
      await onEvent({ kind, path: rel, ts: new Date().toISOString() });
    } catch {
      // swallow handler errors — watcher must keep going
    }
  };

  return {
    async start() {
      ig = await buildMatcher(root);
      watcher = chokidar.watch(root, {
        // Cross-platform glob ignore. We match both the directory itself and
        // anything inside it. picomatch (chokidar's matcher) normalizes path
        // separators so a single set of forward-slash globs handles
        // Windows + POSIX. Function-based ignore was unreliable on Windows
        // and let chokidar descend into .git/, which crashed on transient
        // index.lock files held exclusively by git.
        ignored: ALWAYS_IGNORE.flatMap((d) => [`**/${d}`, `**/${d}/**`]),
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });

      // Chokidar emits "error" for transient OS-level issues — most commonly
      // EPERM/ENOENT on rapidly created+deleted files. We never want one of
      // these to crash the syn process. Log + swallow.
      watcher.on("error", (err) => {
        const e = err as NodeJS.ErrnoException;
        log.debug(`file watcher error (swallowed): ${e?.code ?? ""} ${e?.message ?? String(err)}`);
      });

      watcher.on("add", (path) => emit("create", path));
      watcher.on("change", (path) => emit("save", path));
      watcher.on("unlink", (path) => emit("delete", path));
    },

    async stop() {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },
  };
}
