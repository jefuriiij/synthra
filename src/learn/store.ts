// I/O for the usage-learning layer. Two files, both in .synthra-graph/
// (gitignored, machine-local — usage is per-developer):
//   - access_log.jsonl : append-only raw events (source of truth, replayable)
//   - learn_store.json  : derived decayed aggregate (a cache of the log)
//
// Every read is best-effort: a missing / corrupt / schema-mismatched file yields
// an empty store, so the ranker degrades to its deterministic behavior.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { updateJsonFile } from "../shared/json-store.js";
import {
  emptyStore,
  LEARN_SCHEMA_VERSION,
  mergeStores,
  type AccessEvent,
  type LearnStore,
} from "./usage.js";

/** Coerce whatever is on disk into a usable store. Anything off-schema reads as
 *  empty — the aggregate is a cache, and the access log can rebuild it. */
function normalize(parsed: Partial<LearnStore> | null | undefined): LearnStore {
  if (
    !parsed ||
    parsed.schema_version !== LEARN_SCHEMA_VERSION ||
    typeof parsed.files !== "object" ||
    parsed.files === null
  ) {
    return emptyStore();
  }
  return {
    schema_version: LEARN_SCHEMA_VERSION,
    asOf: typeof parsed.asOf === "string" ? parsed.asOf : emptyStore().asOf,
    files: parsed.files as LearnStore["files"],
  };
}

export async function readLearnStore(path: string): Promise<LearnStore> {
  try {
    const raw = await readFile(path, "utf8");
    return normalize(JSON.parse(raw) as Partial<LearnStore>);
  } catch {
    return emptyStore();
  }
}

/** Persist the aggregate, merged against whatever is on disk now rather than
 *  overwriting it — our in-memory copy was loaded at startup and can be missing
 *  paths another writer has learned since. */
export async function writeLearnStore(path: string, store: LearnStore): Promise<void> {
  try {
    await updateJsonFile<LearnStore>(
      path,
      () => store,
      (disk) => mergeStores(store, normalize(disk)),
    );
  } catch {
    // Persistence is best-effort; the log remains the source of truth.
  }
}

export async function readAccessLog(path: string): Promise<AccessEvent[]> {
  try {
    const raw = await readFile(path, "utf8");
    const out: AccessEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t) as AccessEvent;
        if (
          ev &&
          typeof ev.ts === "string" &&
          typeof ev.path === "string" &&
          typeof ev.source === "string"
        ) {
          out.push(ev);
        }
      } catch {
        // Skip a malformed line rather than failing the whole replay.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function appendAccess(path: string, ev: AccessEvent): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    // Best-effort; never fail a tool call over telemetry.
  }
}
