// Daily version-check ping against the npm registry. Runs fire-and-forget at
// startup so we never block the syn flow. Cached at ~/.synthra/version-check.json
// for 24h. Honors SYN_NO_UPDATE_CHECK=1 to opt out.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "../shared/logger.js";

const PKG_NAME = "synthra";
const CACHE_DIR = join(homedir(), ".synthra");
const CACHE_PATH = join(CACHE_DIR, "version-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const FETCH_TIMEOUT_MS = 2000;

interface CheckCache {
  checked_at: string;
  latest_version: string;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
}

let currentVersionCache: string | null = null;

async function getCurrentVersion(): Promise<string> {
  if (currentVersionCache) return currentVersionCache;
  try {
    // Tsup inlines this import at build time.
    const pkg = (await import("../../package.json", { with: { type: "json" } })) as { default: { version: string } } | { version: string };
    const version = "default" in pkg ? pkg.default.version : pkg.version;
    currentVersionCache = version;
    return version;
  } catch {
    return "0.0.0";
  }
}

async function readCache(): Promise<CheckCache | null> {
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<CheckCache>;
    if (!parsed.checked_at || !parsed.latest_version) return null;
    return parsed as CheckCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: CheckCache): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/** Returns true if `candidate` is a higher semver than `baseline`. */
function isNewer(candidate: string, baseline: string): boolean {
  const a = candidate.split(/[.-]/).map((p) => Number(p));
  const b = baseline.split(/[.-]/).map((p) => Number(p));
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = Number.isFinite(a[i]) ? (a[i] as number) : 0;
    const bi = Number.isFinite(b[i]) ? (b[i] as number) : 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

async function fetchLatestFromRegistry(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = await getCurrentVersion();

  if (process.env.SYN_NO_UPDATE_CHECK === "1") {
    return { current, latest: null, hasUpdate: false };
  }

  const cache = await readCache();
  const now = Date.now();
  const cacheAge = cache ? now - Date.parse(cache.checked_at) : Infinity;

  let latest: string | null = null;
  if (cache && cacheAge < CACHE_TTL_MS) {
    latest = cache.latest_version;
  } else {
    latest = await fetchLatestFromRegistry();
    if (latest) {
      await writeCache({ checked_at: new Date().toISOString(), latest_version: latest });
    } else if (cache) {
      // Network failed; reuse last known.
      latest = cache.latest_version;
    }
  }

  const hasUpdate = latest ? isNewer(latest, current) : false;
  return { current, latest, hasUpdate };
}

/** Fire-and-forget — log a single line if an update is available. Never throws. */
export async function logUpdateHintIfNeeded(): Promise<void> {
  try {
    const r = await checkForUpdate();
    if (r.hasUpdate && r.latest) {
      log.info(
        `Synthra ${r.latest} is available (you have ${r.current}) — run: npm install -g synthra@latest`,
      );
    }
  } catch {
    // silent
  }
}
