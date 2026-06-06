// Global registry of projects that have run `syn .` on this machine.
// Stored at ~/.synthra/projects.json so the dashboard can enumerate them
// without walking the filesystem.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const REGISTRY_DIR = join(homedir(), ".synthra");
const REGISTRY_PATH = join(REGISTRY_DIR, "projects.json");
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

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Registry>;
    if (!Array.isArray(parsed.projects)) return { schema_version: SCHEMA_VERSION, projects: [] };
    return { schema_version: parsed.schema_version ?? SCHEMA_VERSION, projects: parsed.projects };
  } catch {
    return { schema_version: SCHEMA_VERSION, projects: [] };
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

/** Upsert this project's entry. Updates `last_seen`; preserves `first_seen`. */
export async function recordProject(projectRoot: string): Promise<void> {
  const now = new Date().toISOString();
  const registry = await readRegistry();
  const existing = registry.projects.find((p) => p.path === projectRoot);
  if (existing) {
    existing.last_seen = now;
    existing.name = basename(projectRoot);
  } else {
    registry.projects.push({
      path: projectRoot,
      name: basename(projectRoot),
      first_seen: now,
      last_seen: now,
    });
  }
  try {
    await writeRegistry(registry);
  } catch {
    // Registry is best-effort — a write failure shouldn't block the session.
  }
}

export async function listProjects(): Promise<ProjectRegistryEntry[]> {
  const registry = await readRegistry();
  // Sort by last_seen descending so the most active project surfaces first.
  return registry.projects
    .slice()
    .sort((a, b) => (a.last_seen > b.last_seen ? -1 : a.last_seen < b.last_seen ? 1 : 0));
}

export { REGISTRY_PATH, REGISTRY_DIR };
