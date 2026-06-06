// Stateful wrapper around the usage-learning store. Keeps the decayed aggregate
// in memory, folds each access as it happens, persists on a trailing debounce,
// and exposes the live scores for the ranker. Constructed once per server, like
// ActivityStore.

import { appendAccess, readAccessLog, readLearnStore, writeLearnStore } from "./store.js";
import {
  effectiveScores,
  foldEvent,
  recomputeFromLog,
  type AccessEvent,
  type LearnStore,
} from "./usage.js";

const PERSIST_DEBOUNCE_MS = 2000;

export class LearnRuntime {
  private store: LearnStore;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly accessLogPath: string,
    private readonly storePath: string,
    store: LearnStore,
  ) {
    this.store = store;
  }

  /** Load the aggregate from disk; if it's empty but a raw log exists, replay it
   *  (the log is the source of truth). Always succeeds — falls back to empty. */
  static async load(accessLogPath: string, storePath: string): Promise<LearnRuntime> {
    let store = await readLearnStore(storePath);
    if (Object.keys(store.files).length === 0) {
      const events = await readAccessLog(accessLogPath);
      if (events.length > 0) store = recomputeFromLog(events);
    }
    return new LearnRuntime(accessLogPath, storePath, store);
  }

  /** Record an access: append to the durable log + fold into the in-memory
   *  aggregate. Best-effort — never throws into a tool call. */
  async record(ev: AccessEvent): Promise<void> {
    await appendAccess(this.accessLogPath, ev);
    foldEvent(this.store, ev);
    this.schedulePersist();
  }

  /** Decayed path→weight map for the ranker, as of now. */
  effectiveScores(nowMs: number = Date.now()): Map<string, number> {
    return effectiveScores(this.store, nowMs);
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    // Don't keep the event loop alive just for the persist timer.
    this.timer.unref?.();
  }

  /** Persist the aggregate if it changed since the last write. Called on the
   *  debounce and on server shutdown. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.store.asOf = new Date().toISOString();
    await writeLearnStore(this.storePath, this.store);
  }
}
