// Pure decay/aggregate core for the usage-learning signal ("the more it's used,
// the smarter it gets"). No I/O here — persistence + the raw access log live in
// store.ts, and the stateful wrapper in runtime.ts.
//
// Files the AI actually pulls (graph_read) or edits (graph_register_edit) accrue
// a time-decayed weight. retrieve() applies a bounded, capped boost so genuinely
// "hot" files surface first — never dominating the deterministic ranker.

export type AccessSource = "read" | "register_edit" | "continue";

export interface AccessEvent {
  ts: string; // ISO timestamp
  path: string; // canonical FileNode.path ("" for source === "continue")
  source: AccessSource;
  query?: string; // only set for source === "continue" — reserved fuel for v2/v3
}

export interface FileStat {
  /** Raw access count (never decayed) — diagnostic only. */
  count: number;
  /** Decayed weight as of `lastTs`. */
  decayed: number;
  /** ISO timestamp of the most recent folded event. */
  lastTs: string;
}

export interface LearnStore {
  schema_version: number;
  asOf: string;
  files: Record<string, FileStat>;
}

export const LEARN_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Usage-decay half-life. Env-overridable for dogfood tuning. */
export function halfLifeMs(): number {
  const env = Number(process.env.SYN_LEARN_HALFLIFE_DAYS);
  const days = Number.isFinite(env) && env > 0 ? env : 7;
  return days * DAY_MS;
}

/** Per-source accrual weight. `continue` never contributes to frequency — it's
 *  logged only as query→outcome fuel for a future mechanism. */
export function weightFor(source: AccessSource): number {
  switch (source) {
    case "register_edit":
      return 2;
    case "read":
      return 1;
    default:
      return 0;
  }
}

export function emptyStore(): LearnStore {
  return {
    schema_version: LEARN_SCHEMA_VERSION,
    asOf: new Date(0).toISOString(),
    files: {},
  };
}

/** exp(-λ·Δt) decay multiplier from `fromTs` forward to `toMs` epoch ms. */
function decayFactor(fromTs: string, toMs: number, hl: number): number {
  const fromMs = Date.parse(fromTs);
  if (!Number.isFinite(fromMs)) return 1;
  const dt = toMs - fromMs;
  if (dt <= 0) return 1;
  return Math.exp(-(Math.LN2 / hl) * dt);
}

/** Fold one access event into the store: decay the file's prior weight up to the
 *  event's timestamp, then add the event weight. Mutates and returns `store`.
 *  Zero-weight (`continue`) and path-less events are ignored. Malformed
 *  timestamps are dropped so the function stays deterministic. */
export function foldEvent(store: LearnStore, ev: AccessEvent): LearnStore {
  const w = weightFor(ev.source);
  if (w <= 0 || !ev.path) return store;
  const tMs = Date.parse(ev.ts);
  if (!Number.isFinite(tMs)) return store;

  const hl = halfLifeMs();
  const prev = store.files[ev.path];
  if (prev) {
    const decayed = prev.decayed * decayFactor(prev.lastTs, tMs, hl) + w;
    store.files[ev.path] = { count: prev.count + 1, decayed, lastTs: ev.ts };
  } else {
    store.files[ev.path] = { count: 1, decayed: w, lastTs: ev.ts };
  }
  return store;
}

/** Decayed weights as of `nowMs`, keyed by path. Effectively-zero entries are
 *  omitted so an old/cold store contributes nothing. */
export function effectiveScores(store: LearnStore, nowMs: number): Map<string, number> {
  const hl = halfLifeMs();
  const out = new Map<string, number>();
  for (const [path, stat] of Object.entries(store.files)) {
    const eff = stat.decayed * decayFactor(stat.lastTs, nowMs, hl);
    if (eff > 0.01) out.set(path, eff);
  }
  return out;
}

/** Rebuild a store by replaying a raw access-log stream (the source of truth). */
export function recomputeFromLog(events: AccessEvent[]): LearnStore {
  const store = emptyStore();
  for (const ev of events) foldEvent(store, ev);
  return store;
}

/** Newest event timestamp in a log, or null for an empty/undateable one. */
export function latestEventTs(events: AccessEvent[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const ev of events) {
    const ms = Date.parse(ev.ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = ev.ts;
    }
  }
  return best;
}

/**
 * Combine two aggregates path-by-path, keeping whichever entry folded the more
 * recent event. Needed because the store is written whole: without a merge, a
 * writer holding an older view silently drops every path the other one learned.
 * Weights aren't summed — both sides derive from the same append-only log, so
 * adding them would double-count shared history.
 */
export function mergeStores(ours: LearnStore, theirs: LearnStore): LearnStore {
  const files: Record<string, FileStat> = { ...theirs.files };
  for (const [path, stat] of Object.entries(ours.files)) {
    const other = files[path];
    // NaN comparisons are false, so an unparseable timestamp on either side
    // loses to the entry we can actually date.
    if (!other || Date.parse(stat.lastTs) >= Date.parse(other.lastTs)) files[path] = stat;
  }
  const oursAsOf = Date.parse(ours.asOf);
  const theirsAsOf = Date.parse(theirs.asOf);
  return {
    schema_version: LEARN_SCHEMA_VERSION,
    asOf: oursAsOf >= theirsAsOf || !Number.isFinite(theirsAsOf) ? ours.asOf : theirs.asOf,
    files,
  };
}
