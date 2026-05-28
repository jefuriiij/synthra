// chokidar-based file watcher. Emits save/create/delete events for human
// edits inside the project. Respects .gitignore + .synthraignore plus a
// hard-coded list of always-ignored directories (.git, .synthra*, .claude,
// node_modules, dist, build, coverage).

import chokidar, { type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

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
        // We layer our own .gitignore/.synthraignore handling via emit().
        // Restrict at the chokidar level to skip the heaviest dirs.
        ignored: (path: string) => ALWAYS_IGNORE.some((d) => path.includes(`${sep}${d}${sep}`) || path.endsWith(`${sep}${d}`)),
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
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
