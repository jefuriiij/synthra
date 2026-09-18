// Global registry of projects that have run `syn .` on this machine.
// Stored at ~/.synthra/projects.json so the dashboard can enumerate them
// without walking the filesystem.
//
// `registryPath()` is a FUNCTION with an overridable argument on every export,
// rather than a module-scope const computed from homedir() at import time. That
// const was why four of this module's five exports had no test coverage at all,
// and why forgetProject had to re-implement read+write inline to escape the
// closure over it. Same convention as favorites.ts.

import { homedir } from "node:os";
import { basename, join } from "node:path";

import { readJsonFile, updateJsonFile } from "./json-store.js";
import { log } from "./logger.js";
import { normalizeRoot } from "./paths.js";

const SCHEMA_VERSION = 1;

export interface ProjectRegistryEntry {
  path: string; // absolute project root
  name: string; // basename for display
  first_seen: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

interface Registry {
  schema_version: number;
  projects: ProjectRegistryEntry[];
}

/** `~/.synthra/projects.json`. A function so tests can point at a temp home. */
export function registryPath(homeDir = homedir()): string {
  return join(homeDir, ".synthra", "projects.json");
}

function emptyRegistry(): Registry {
  return { schema_version: SCHEMA_VERSION, projects: [] };
}

/**
 * Upsert this project's entry. Updates `last_seen`; preserves `first_seen`.
 *
 * Matching is case/slash-insensitive (see normalizeRoot). An exact string
 * compare meant `C:\…\VelocityCG` from a shell and `c:\…\VelocityCG` from an
 * editor's extension host registered as two projects — the dashboard then read
 * the SAME .synthra-graph/ twice and double-counted every global total. Any
 * such pre-existing pairs are merged on the next write, keeping the earliest
 * first_seen and the latest last_seen.
 *
 * Best-effort by design — a registry problem must never block a session — but
 * "best effort" now stops short of destruction: a registry that won't parse is
 * quarantined rather than replaced by a one-entry file containing only this
 * project. Two `syn .` runs in different projects at the same moment used to
 * lose one of the entries; the update is serialized and retried instead.
 */
export async function recordProject(projectRoot: string, path = registryPath()): Promise<void> {
  const now = new Date().toISOString();
  const key = normalizeRoot(projectRoot);

  const result = await updateJsonFile<Registry>(path, emptyRegistry, (registry) => {
    const raw = Array.isArray(registry.projects) ? registry.projects : [];

    // Collapse any duplicates already on disk, oldest-first so the surviving
    // entry keeps the earliest first_seen.
    const byRoot = new Map<string, ProjectRegistryEntry>();
    for (const p of raw) {
      if (!p?.path) continue;
      const k = normalizeRoot(p.path);
      const prior = byRoot.get(k);
      if (!prior) {
        byRoot.set(k, p);
        continue;
      }
      byRoot.set(k, {
        ...prior,
        first_seen: prior.first_seen < p.first_seen ? prior.first_seen : p.first_seen,
        last_seen: prior.last_seen > p.last_seen ? prior.last_seen : p.last_seen,
      });
    }

    const existing = byRoot.get(key);
    byRoot.set(key, {
      // Keep the stored spelling once recorded — rewriting it on every run
      // would churn the file for no benefit.
      path: existing?.path ?? projectRoot,
      name: basename(projectRoot),
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
    });

    return {
      schema_version: registry.schema_version ?? SCHEMA_VERSION,
      projects: [...byRoot.values()],
    };
  });

  if (result.status === "corrupt") {
    log.warn(
      `${path} could not be parsed (${result.error}) — this project wasn't recorded, and your other projects were left intact.` +
        (result.quarantined ? ` A copy is at ${result.quarantined}.` : ""),
    );
  }
}

/** Remove this project's entry. Matching is case/slash-insensitive, so
 *  `syn remove` deletes the entry even when it was recorded under a different
 *  spelling of the same path. A missing or unparseable registry is not an error. */
export async function forgetProject(projectRoot: string, path = registryPath()): Promise<boolean> {
  let removed = false;
  const key = normalizeRoot(projectRoot);
  const result = await updateJsonFile<Registry>(path, emptyRegistry, (registry) => {
    const projects = Array.isArray(registry.projects) ? registry.projects : [];
    const filtered = projects.filter((p) => normalizeRoot(p?.path ?? "") !== key);
    if (filtered.length === projects.length) return null; // nothing to do, no write
    removed = true;
    return { schema_version: registry.schema_version ?? SCHEMA_VERSION, projects: filtered };
  });
  return result.status === "written" && removed;
}

export async function listProjects(path = registryPath()): Promise<ProjectRegistryEntry[]> {
  const read = await readJsonFile<Partial<Registry>>(path);
  if (read.status === "corrupt") {
    // Report it rather than implying the machine has no projects. Nothing is
    // written here, so the file survives for recordProject to quarantine.
    log.warn(`${path} could not be parsed (${read.error}) — the project list is unavailable.`);
    return [];
  }
  if (read.status === "missing" || !Array.isArray(read.data.projects)) return [];
  // Dedupe on read as well as on write: the dashboard enumerates from here on
  // every /data poll, and a registry written by an older Synthra can still hold
  // the same root under two spellings. Left un-deduped, both entries resolve to
  // one .synthra-graph/ and every global total counts it twice.
  const byRoot = new Map<string, ProjectRegistryEntry>();
  for (const p of read.data.projects) {
    if (!p?.path) continue;
    const k = normalizeRoot(p.path);
    const prior = byRoot.get(k);
    if (!prior) {
      byRoot.set(k, p);
      continue;
    }
    byRoot.set(k, {
      ...prior,
      first_seen: prior.first_seen < p.first_seen ? prior.first_seen : p.first_seen,
      last_seen: prior.last_seen > p.last_seen ? prior.last_seen : p.last_seen,
    });
  }
  // Sort by last_seen descending so the most active project surfaces first.
  return [...byRoot.values()].sort((a, b) =>
    a.last_seen > b.last_seen ? -1 : a.last_seen < b.last_seen ? 1 : 0,
  );
}
