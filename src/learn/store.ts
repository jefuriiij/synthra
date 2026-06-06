// I/O for the usage-learning layer. Two files, both in .synthra-graph/
// (gitignored, machine-local — usage is per-developer):
//   - access_log.jsonl : append-only raw events (source of truth, replayable)
//   - learn_store.json  : derived decayed aggregate (a cache of the log)
//
// Every read is best-effort: a missing / corrupt / schema-mismatched file yields
// an empty store, so the ranker degrades to its deterministic behavior.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { emptyStore, LEARN_SCHEMA_VERSION, type AccessEvent, type LearnStore } from "./usage.js";

export async function readLearnStore(path: string): Promise<LearnStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LearnStore>;
    if (
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
  } catch {
    return emptyStore();
  }
}

export async function writeLearnStore(path: string, store: LearnStore): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
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
