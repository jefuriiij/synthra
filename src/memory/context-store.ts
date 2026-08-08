// Structured decisions/tasks/facts that persist across sessions.
// Stored in .synthra/ (GIT-TRACKED) so teammates inherit them.
// Branch-partitioned via branches.ts.

import {
  readJsonFile,
  updateJsonFile,
  writeJsonAtomic,
  type UpdateResult,
} from "../shared/json-store.js";

export type EntryKind = "decision" | "task" | "next" | "fact" | "blocker";

/** Content-hash snapshot of a linked file at capture time. Lets recall flag an
 *  entry "possibly stale" when the anchored file has changed since it was stored. */
export interface EntryAnchor {
  path: string;
  hash: string;
}

export interface ContextEntry {
  type: EntryKind;
  content: string;
  tags: string[];
  files: string[];
  date: string;
  /** Provenance. Reserved for v2 auto-capture; v1 only writes manual entries, so
   *  the field is omitted today and read back as undefined (treated as manual). */
  source?: "manual" | "auto";
  /** Staleness anchors (v0.15+). Optional + additive — older entries (and entries
   *  whose files weren't in the graph at capture) simply have none and are never
   *  flagged. The store SCHEMA_VERSION stays 1: readers ignore unknown fields. */
  anchors?: EntryAnchor[];
}

interface Store {
  schema_version: number;
  entries: ContextEntry[];
}

const SCHEMA_VERSION = 1;

/**
 * A damaged store must be distinguishable from an empty one. Reading it as `[]`
 * used to be doubly destructive: the next append persisted a 1-entry store over
 * however many entries were really in there, and CONTEXT.md — which is
 * git-tracked — got rewritten to say there were none.
 */
export type StoreRead =
  | { status: "ok"; entries: ContextEntry[] }
  | { status: "corrupt"; error: string };

export async function readStore(path: string): Promise<StoreRead> {
  const read = await readJsonFile<Partial<Store>>(path);
  if (read.status === "missing") return { status: "ok", entries: [] };
  if (read.status === "corrupt") return { status: "corrupt", error: read.error };
  // A file that parses but has no entries array is structurally wrong, not torn;
  // treat it as empty exactly as before rather than quarantining it.
  return { status: "ok", entries: Array.isArray(read.data.entries) ? read.data.entries : [] };
}

export async function writeEntries(path: string, entries: ContextEntry[]): Promise<void> {
  const store: Store = { schema_version: SCHEMA_VERSION, entries };
  await writeJsonAtomic(path, store);
}

/** Append one entry. Returns `corrupt` — having quarantined the damaged file —
 *  rather than replacing a store it couldn't read.
 *
 *  `onPersisted` runs before the store's queue slot is released, so a derived
 *  view (CONTEXT.md) can be rendered from exactly these entries with no other
 *  writer able to interleave. */
export async function appendEntry(
  path: string,
  entry: ContextEntry,
  onPersisted?: (entries: ContextEntry[]) => Promise<void>,
): Promise<UpdateResult<Store>> {
  return updateJsonFile<Store>(
    path,
    () => ({ schema_version: SCHEMA_VERSION, entries: [] }),
    (store) => ({
      schema_version: SCHEMA_VERSION,
      entries: [...(Array.isArray(store.entries) ? store.entries : []), entry],
    }),
    onPersisted ? { afterWrite: (store) => onPersisted(store.entries) } : {},
  );
}

/**
 * Render a derived view of the store while holding its queue slot, without
 * changing it. This is how CONTEXT.md gets refreshed safely: reading the store
 * and then writing the narrative as two separate steps lets a `context_remember`
 * land in between, and the narrative — written from the older read — drops it.
 * The entry survives in the store, so the loss shows up only in the git-tracked
 * file nobody diffs.
 */
export async function renderFromStore(
  path: string,
  render: (entries: ContextEntry[]) => Promise<void>,
): Promise<UpdateResult<Store>> {
  return updateJsonFile<Store>(
    path,
    () => ({ schema_version: SCHEMA_VERSION, entries: [] }),
    () => null, // read-only: never rewrite the store just to publish a view
    { afterWrite: (store) => render(Array.isArray(store.entries) ? store.entries : []) },
  );
}
