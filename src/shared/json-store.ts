// Safe reads and writes for Synthra's JSON state files.
//
// Two problems this exists to solve, both found by auditing every write in src/:
//
// 1. NOTHING was atomic. Every writer was a plain writeFile, so a crash or a
//    killed process mid-write leaves a truncated file. That is where corrupt
//    state comes from in the first place.
//
// 2. Worse: every reader caught its parse error and degraded to "empty", and
//    every writer then PERSISTED that emptiness. One torn read of
//    context-store.json wrote back a 1-entry store; one torn read of
//    settings.local.json rewrote it with only Synthra's hooks, discarding every
//    permission the user had granted. The graceful catch was right for a first
//    run and destructive for a damaged file, because nothing told the two apart.
//
// So: `missing` and `corrupt` are different states here, and a corrupt file is
// never overwritten — it is moved aside so the data is recoverable by hand.
//
// JSONL logs deliberately do NOT belong here. They are single small appends and
// their readers already skip unparseable lines; wrapping them would add cost for
// no safety.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** A file that exists but won't parse is NOT the same as one that isn't there. */
export type ReadResult<T> =
  | { status: "ok"; data: T }
  | { status: "missing" }
  | { status: "corrupt"; error: string };

export type UpdateResult<T> =
  | { status: "written"; data: T; contended?: boolean }
  | { status: "unchanged" }
  | { status: "corrupt"; error: string; quarantined?: string };

/** Rename onto an existing target fails transiently on Windows with EPERM/EBUSY
 *  — an AV scanner, another handle, or simply another rename onto the same target
 *  in flight. Reproduced under a 5-way concurrent write, not hypothetical, and
 *  the same class of flake the file watcher already carries scar tissue for. So:
 *  several attempts with jittered backoff, rather than one hopeful try. */
const RENAME_ATTEMPTS = 8;
const RENAME_BACKOFF_MS = 15;
/** Don't litter a directory with one `.corrupt-*` copy per retry loop. */
const QUARANTINE_WINDOW_MS = 10_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Temp names must be unique per CALL, not per process. Sharing one name across
// two concurrent updates of the same file meant each overwrote the other's temp
// and then renamed it into place — one update's content landing under the
// other's write, and the loser re-applying its mutation on top. The pid keeps
// separate processes apart; the counter keeps concurrent calls in one process
// apart.
let tmpSeq = 0;

/** Raw contents, or null when the file isn't readable at all. */
async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read and parse a JSON file. An absent OR empty file reads as `missing`, which
 * callers may safely overwrite; anything that exists but won't parse reads as
 * `corrupt`, which they must not. Permission errors count as corrupt too: there
 * is something there, we just can't see it, so overwriting would destroy it.
 */
export async function readJsonFile<T>(path: string): Promise<ReadResult<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return isMissing(err) ? { status: "missing" } : { status: "corrupt", error: errMessage(err) };
  }
  return parseRead<T>(text);
}

function parseRead<T>(text: string): ReadResult<T> {
  // A zero-byte file is what a crashed writeFile leaves behind. There's no data
  // in it to lose, so treat it as a fresh start rather than a corruption.
  if (!text.trim()) return { status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: "corrupt", error: errMessage(err) };
  }
  // A file containing literally `null` is valid JSON that holds no value, so
  // it's a fresh start rather than data worth protecting. Callers shape-check
  // the rest themselves (every one of them does an Array.isArray on its list),
  // so don't be stricter than that here.
  if (parsed === null) return { status: "missing" };
  return { status: "ok", data: parsed as T };
}

/**
 * Move a damaged file to `<name>.corrupt-<timestamp>` and return the new path.
 * Nothing is deleted — the point is that the user can still recover what was in
 * there. Returns null if the move itself failed, or if we already set a copy
 * aside within the last few seconds (a caller in a retry loop shouldn't produce
 * a pile of near-identical copies).
 */
export async function quarantineFile(path: string): Promise<string | null> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  try {
    const now = Date.now();
    for (const name of await readdir(dir)) {
      if (!name.startsWith(prefix)) continue;
      const s = await stat(join(dir, name)).catch(() => null);
      if (s && now - s.mtimeMs < QUARANTINE_WINDOW_MS) return null; // already have one
    }
  } catch {
    // unreadable directory — fall through and just attempt the rename
  }
  const target = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await rename(path, target);
    return target;
  } catch {
    return null;
  }
}

function serialize(data: unknown, pretty: boolean): string {
  // Trailing newline matches every existing writer in the repo.
  return `${pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)}\n`;
}

/**
 * Write via a sibling temp file and one rename. The rename is what makes this
 * atomic: a reader sees either the whole old file or the whole new one, never a
 * half-written mixture. It's a metadata operation, so a 900 KB graph renames as
 * fast as a 45-byte registry.
 *
 * `verify` runs after the temp file is written and immediately before the
 * rename, so a caller can abort if the target changed underneath it. Returning
 * false aborts without touching the target.
 */
async function writeAtomic(
  path: string,
  text: string,
  verify?: () => Promise<boolean>,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  await writeFile(tmp, text, "utf8");

  if (verify && !(await verify())) {
    // Aborted before touching the target — don't leave our temp behind.
    await rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, path);
      return true;
    } catch (err) {
      // Out of attempts: clean up our temp and rethrow. The target is still the
      // last good version — that's the whole point of writing beside it.
      if (attempt >= RENAME_ATTEMPTS) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await sleep(RENAME_BACKOFF_MS * attempt + Math.floor(Math.random() * 10));
    }
  }
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await writeAtomic(path, text);
}

export async function writeJsonAtomic(
  path: string,
  data: unknown,
  opts: { pretty?: boolean } = {},
): Promise<void> {
  await writeAtomic(path, serialize(data, opts.pretty ?? true));
}

// One promise chain per file path. This is what actually makes concurrent
// read-modify-write safe INSIDE a process, and it is not redundant with the
// optimistic retry below: verify-then-rename is inherently check-then-act, so
// two callers can both verify before either renames, and the second rename wins.
// Serializing removes that window entirely for same-process callers — two Claude
// sessions on one server, or two dashboard tabs. Across processes the byte
// comparison plus retry is the best available without a lock file, and the
// residual window is microseconds against a real-world gap of seconds.
const queues = new Map<string, Promise<unknown>>();

function serializeByPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(path) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Keep the chain tail resolved so one rejection can't stall the file forever,
  // and drop the entry when we're the last in line to avoid unbounded growth.
  const tail = run
    .catch(() => undefined)
    .then(() => {
      if (queues.get(path) === tail) queues.delete(path);
    });
  queues.set(path, tail);
  return run;
}

/**
 * Read-modify-write that can neither destroy a corrupt file nor lose a
 * concurrent update.
 *
 *   corrupt          → quarantine it, write NOTHING, report back
 *   missing          → start from init()
 *   mutate returns null → nothing to do, no write at all
 *
 * Concurrency is handled optimistically rather than with a lock: the exact bytes
 * read are compared against a fresh read immediately before the rename, and the
 * mutation is redone against what actually landed if anything changed. No lock
 * files means no stale locks to recover from after a crash.
 *
 * The comparison is byte-exact on purpose. size+mtime looked cheaper but is not
 * sufficient here: several appends inside one millisecond produce an identical
 * size AND an identical mtime, so a "nothing changed" verdict silently dropped
 * updates. These files are kilobytes, so re-reading them costs nothing.
 *
 * `afterWrite` runs while this file's queue slot is still held, receiving the
 * state that is now on disk. Use it for anything DERIVED from this file that
 * must not be rendered from a stale read — outside the slot, a concurrent
 * update can land between the read and the derived write, and the derived
 * output silently reverts it.
 */
export interface UpdateOptions<T> {
  pretty?: boolean;
  retries?: number;
  afterWrite?: (data: T) => Promise<void>;
}

export function updateJsonFile<T>(
  path: string,
  init: () => T,
  mutate: (current: T) => T | null,
  opts: UpdateOptions<T> = {},
): Promise<UpdateResult<T>> {
  return serializeByPath(path, () => updateOnce(path, init, mutate, opts));
}

export type TextUpdateResult =
  | { status: "written"; text: string; contended?: boolean }
  | { status: "unchanged" };

/**
 * The text sibling of `updateJsonFile`, for files we append to but do not own:
 * `.gitignore` and `CLAUDE.md`. Same per-path serialization and same
 * byte-compare before the rename, so an edit the user (or another tool) makes
 * between our read and our write is noticed and merged into rather than
 * flattened.
 *
 * `mutate` receives `null` when the file doesn't exist — distinct from `""`,
 * which is a real empty file — and returns `null` to mean "nothing to do", so
 * the common idempotent re-run writes nothing at all.
 *
 * There is no `corrupt` state here, unlike the JSON side: any byte sequence is
 * valid text, so there is nothing to fail to parse and nothing to quarantine.
 */
export function updateTextFile(
  path: string,
  mutate: (current: string | null) => string | null,
  opts: { retries?: number } = {},
): Promise<TextUpdateResult> {
  return serializeByPath(path, () => updateTextOnce(path, mutate, opts));
}

async function updateTextOnce(
  path: string,
  mutate: (current: string | null) => string | null,
  opts: { retries?: number },
): Promise<TextUpdateResult> {
  const retries = opts.retries ?? 10;

  for (let attempt = 0; ; attempt++) {
    const before = await readRaw(path);
    const next = mutate(before);
    if (next === null || next === before) return { status: "unchanged" };

    const lastAttempt = attempt >= retries;
    const wrote = await writeAtomic(path, next, async () =>
      lastAttempt ? true : (await readRaw(path)) === before,
    );
    if (wrote) {
      return { status: "written", text: next, ...(attempt > 0 ? { contended: true } : {}) };
    }
    await sleep(1 + Math.floor(Math.random() * 4));
  }
}

async function updateOnce<T>(
  path: string,
  init: () => T,
  mutate: (current: T) => T | null,
  opts: UpdateOptions<T>,
): Promise<UpdateResult<T>> {
  const retries = opts.retries ?? 10;

  for (let attempt = 0; ; attempt++) {
    const before = await readRaw(path);
    const read = before === null ? ({ status: "missing" } as const) : parseRead<T>(before);

    if (read.status === "corrupt") {
      const quarantined = await quarantineFile(path);
      return {
        status: "corrupt",
        error: read.error,
        ...(quarantined ? { quarantined } : {}),
      };
    }

    const current = read.status === "ok" ? read.data : init();
    const next = mutate(current);
    if (next === null) {
      // Nothing to write, but the read was authoritative and we still hold the
      // slot — so a derived view rendered here is just as safe as after a write.
      await opts.afterWrite?.(current);
      return { status: "unchanged" };
    }

    const lastAttempt = attempt >= retries;
    const wrote = await writeAtomic(path, serialize(next, opts.pretty ?? true), async () =>
      // On the very last attempt take the write regardless: a persistent
      // conflict is better resolved as last-writer-wins than looped on forever.
      lastAttempt ? true : (await readRaw(path)) === before,
    );
    if (wrote) {
      await opts.afterWrite?.(next);
      return { status: "written", data: next, ...(attempt > 0 ? { contended: true } : {}) };
    }
    // Jitter so a group of contending writers doesn't retry in lockstep.
    await sleep(1 + Math.floor(Math.random() * 4));
  }
}
