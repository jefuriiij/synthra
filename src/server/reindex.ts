// Auto-reindex: keep the in-memory graph fresh while the server runs. When a
// source file changes, re-run the incremental scan (only the changed file hits
// tree-sitter; the rest reuse the content-hash parse cache) and atomically swap
// the graph + symbolIndex the MCP tools read — so graph_read / blast_radius /
// the dependency footer never serve stale bodies or signatures mid-session.

import { scanProject } from "../cli/scan-command.js";
import { readGraph, readSymbolIndex } from "../graph/store.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import type { ServerContext } from "./context.js";

/**
 * Re-run the incremental scan and atomically swap `ctx.graph` / `ctx.symbolIndex`.
 * Best-effort: a transient scan failure is logged and swallowed, never thrown,
 * so a bad rescan can't take the server down. Shared by the file-change
 * reindexer and the git branch-switch handler.
 */
export async function rescanAndSwap(
  ctx: ServerContext,
  paths: SynthraPaths,
  label: string,
): Promise<void> {
  try {
    // skipBootstrap: a re-parse must not rewrite watched root files
    // (CLAUDE.md/.gitignore) — doing so from a file-change handler would feed
    // the watcher its own edits and loop forever. The project is already
    // bootstrapped at startup.
    await scanProject(paths.projectRoot, { silent: true, skipBootstrap: true });
    const [graph, symbolIndex] = await Promise.all([
      readGraph(paths.infoGraph),
      readSymbolIndex(paths.symbolIndex),
    ]);
    if (graph === null || symbolIndex === null) {
      // Keep serving the in-memory graph we already have. A mid-session reindex
      // that can't read its own output is a warning, not a reason to go blind.
      log.warn(`reindex (${label}) produced an unreadable graph — keeping the previous one.`);
      return;
    }
    ctx.graph = graph;
    ctx.symbolIndex = symbolIndex;
    log.info(`reindexed (${label}) — ${graph.symbol_count} symbols, ${graph.edge_count} edges.`);
  } catch (err) {
    log.warn(`reindex failed (${label}): ${(err as Error).message}`);
  }
}

export interface Reindexer {
  /** Note a change; runs a single rescan once changes settle (debounced). */
  schedule(): void;
  /**
   * Rescan immediately, sharing the same non-overlap guard as `schedule()`.
   * For events that shouldn't wait out the debounce (a branch switch changes
   * every file at once) but still must not run a second scanner alongside one
   * already in flight — two concurrent `scanProject` runs write the same graph
   * files, and the loser's output is what survives.
   */
  runNow(label: string): Promise<void>;
  /** Cancel any pending rescan (call on server shutdown). */
  stop(): void;
}

type RescanFn = (ctx: ServerContext, paths: SynthraPaths, label: string) => Promise<void>;

/**
 * Debounced, non-overlapping reindex scheduler. A burst of file-change events
 * coalesces into one rescan; if more changes arrive while a rescan is in
 * flight, exactly one trailing rescan runs after it finishes. `rescan` is
 * injectable for tests.
 */
export function createReindexer(
  ctx: ServerContext,
  paths: SynthraPaths,
  opts: { debounceMs?: number; rescan?: RescanFn } = {},
): Reindexer {
  const debounceMs = opts.debounceMs ?? 1000;
  const rescan = opts.rescan ?? rescanAndSwap;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let pendingLabel = "edit";
  let inFlight: Promise<void> = Promise.resolve();

  async function run(label: string): Promise<void> {
    if (running) {
      // A scan is already going. Don't start a second one — note that the
      // world moved again and let the current scan chain one more when it
      // lands. Callers awaiting runNow() await that trailing scan too.
      pending = true;
      pendingLabel = label;
      return inFlight;
    }
    running = true;
    inFlight = (async () => {
      try {
        await rescan(ctx, paths, label);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          await run(pendingLabel);
        }
      }
    })();
    return inFlight;
  }

  return {
    runNow(label: string) {
      // A branch switch invalidates everything; a debounced edit-scan already
      // queued would only rescan the same tree again.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return run(label);
    },
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run("edit");
      }, debounceMs);
      // Don't keep the process alive just for a pending reindex.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
