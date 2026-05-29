// Daily version-check ping against the npm registry. Cached at
// ~/.synthra/version-check.json for 24h. Honors SYN_NO_UPDATE_CHECK=1 to opt out.
//
// Two surfaces:
//   - logUpdateHintIfNeeded(): silent log only (used by non-interactive paths)
//   - promptForUpdateOrLog(): interactive prompt that offers to npm install and
//     exit with re-run instructions on success.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import spawn from "cross-spawn";

import { log } from "../shared/logger.js";

const PKG_NAME = "@jefuriiij/synthra";
const CACHE_DIR = join(homedir(), ".synthra");
const CACHE_PATH = join(CACHE_DIR, "version-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Scoped package: encode '@' and '/' for the registry URL.
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/latest`;
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
        `Synthra ${r.latest} is available (you have ${r.current}) — run: npm install -g @jefuriiij/synthra@latest`,
      );
    }
  } catch {
    // silent
  }
}

/**
 * Ask a yes/no question on stdin/stdout. Returns true only on explicit "y" /
 * "yes". Empty input or anything else returns false (safer default for an
 * unattended-update prompt).
 */
async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Run npm install -g for Synthra. Inherits stdio so the user sees progress. */
function runNpmUpdate(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["install", "-g", PKG_NAME + "@latest"], {
      stdio: "inherit",
    });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Interactive update flow. Checks for a new version; if one exists AND we're
 * running on a TTY, prompts the user [y/N]. On 'y', runs npm install and
 * exits with re-run instructions (the currently-running Node process is the
 * old version — can't hot-swap our own code mid-run). On 'n' or non-TTY, logs
 * the hint and returns so the caller can continue. Never throws.
 */
export async function promptForUpdateOrLog(): Promise<void> {
  try {
    const r = await checkForUpdate();
    if (!r.hasUpdate || !r.latest) return;

    // Non-interactive (CI, piped stdin) — preserve the old fire-and-forget hint.
    if (!process.stdin.isTTY) {
      log.info(
        `Synthra ${r.latest} is available (you have ${r.current}) — run: npm install -g @jefuriiij/synthra@latest`,
      );
      return;
    }

    log.info(`Synthra ${r.latest} is available (you have ${r.current}).`);
    const yes = await promptYesNo("[syn] Update now? [y/N]: ");
    if (!yes) {
      log.info("Skipping update — continuing with current version.");
      return;
    }

    log.info(`Running: npm install -g ${PKG_NAME}@latest`);
    const ok = await runNpmUpdate();
    if (!ok) {
      log.warn("npm install failed — continuing with current version.");
      return;
    }
    log.info(`✓ Updated to ${r.latest}. Please re-run: syn .`);
    process.exit(0);
  } catch {
    // silent
  }
}
