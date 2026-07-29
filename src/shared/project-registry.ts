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
 * Best-effort by design — a registry problem must never block a session — but
 * "best effort" now stops short of destruction: a registry that won't parse is
 * quarantined rather than replaced by a one-entry file containing only this
 * project. Two `syn .` runs in different projects at the same moment used to
 * lose one of the entries; the update is serialized and retried instead.
 */
export async function recordProject(projectRoot: string, path = registryPath()): Promise<void> {
  const now = new Date().toISOString();

  const result = await updateJsonFile<Registry>(path, emptyRegistry, (registry) => {
    const projects = Array.isArray(registry.projects) ? [...registry.projects] : [];
    const at = projects.findIndex((p) => p.path === projectRoot);
    const existing = projects[at];
    if (existing) {
      projects[at] = { ...existing, last_seen: now, name: basename(projectRoot) };
    } else {
      projects.push({
        path: projectRoot,
        name: basename(projectRoot),
        first_seen: now,
        last_seen: now,
      });
    }
    return { schema_version: registry.schema_version ?? SCHEMA_VERSION, projects };
  });

  if (result.status === "corrupt") {
    log.warn(
      `${path} could not be parsed (${result.error}) — this project wasn't recorded, and your other projects were left intact.` +
        (result.quarantined ? ` A copy is at ${result.quarantined}.` : ""),
    );
  }
}

/** Remove this project's entry (exact-path match). Returns whether anything was
 *  removed. A missing or unparseable registry is not an error. */
export async function forgetProject(projectRoot: string, path = registryPath()): Promise<boolean> {
  let removed = false;
  const result = await updateJsonFile<Registry>(path, emptyRegistry, (registry) => {
    const projects = Array.isArray(registry.projects) ? registry.projects : [];
    const filtered = projects.filter((p) => p.path !== projectRoot);
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
  // Sort by last_seen descending so the most active project surfaces first.
  return read.data.projects
    .slice()
    .sort((a, b) => (a.last_seen > b.last_seen ? -1 : a.last_seen < b.last_seen ? 1 : 0));
}
