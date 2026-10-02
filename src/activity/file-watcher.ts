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

const ALWAYS = new Set(ALWAYS_IGNORE);

/** Inside one of the always-ignored folders (.git, .claude, node_modules...),
 *  judged on the path below the root, so a project that itself sits in a
 *  folder named "build" is still watched. */
export function isAlwaysIgnored(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..")) return false;
  return rel.split(sep).some((seg) => ALWAYS.has(seg));
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
        // A function, not globs: chokidar 4 and later take no globs, so the
        // old "**/.git/**" patterns matched nothing and every ignored folder
        // was watched anyway. On Windows a watched folder can't be renamed,
        // which broke archiving a project skill (EPERM), and .git's
        // index.lock crashed the watcher. The segment test also keeps it out
        // of .git before it descends.
        ignored: (path: string) => isAlwaysIgnored(root, path),
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
