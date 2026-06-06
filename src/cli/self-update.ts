// Update flow:
//
//   1. At every `syn .` startup, check the npm registry for the latest
//      version. If we're on latest, stay silent. If outdated, prompt the
//      user [y/N]. On 'y', run `npm install -g …@latest` with inherited
//      stdio, print the new version's changelog section from the freshly-
//      installed package, then exit with re-run instructions.
//
//   2. On every startup, compare the running binary's version to a
//      persisted "last seen" version at ~/.synthra/last-seen-version.json.
//      If running > last-seen, print the changelog for the running version
//      (catches manual `npm install -g …@latest` upgrades that bypassed
//      our prompt). On a fresh install (no last-seen file), set last-seen
//      silently without printing — new users don't need the changelog.
//
//   No 24h cache — the user explicitly asked for "always check on every
//   `syn .` run." Cost: one ~100–300ms HTTPS round-trip per startup, hard-
//   capped by FETCH_TIMEOUT_MS. SYN_NO_UPDATE_CHECK=1 opts out of (1)
//   only; the local last-seen comparison in (2) still fires.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import spawn from "cross-spawn";

import { log } from "../shared/logger.js";

const PKG_NAME = "@jefuriiij/synthra";
const SYNTHRA_DIR = join(homedir(), ".synthra");
const LAST_SEEN_PATH = join(SYNTHRA_DIR, "last-seen-version.json");
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/latest`;
const FETCH_TIMEOUT_MS = 2000;

interface LastSeenFile {
  version: string;
  updated_at: string;
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
    const pkg = (await import("../../package.json", { with: { type: "json" } })) as
      | { default: { version: string } }
      | { version: string };
    const version = "default" in pkg ? pkg.default.version : pkg.version;
    currentVersionCache = version;
    return version;
  } catch {
    return "0.0.0";
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

  const latest = await fetchLatestFromRegistry();
  const hasUpdate = latest ? isNewer(latest, current) : false;
  return { current, latest, hasUpdate };
}

async function readLastSeen(): Promise<string | null> {
  try {
    const raw = await readFile(LAST_SEEN_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<LastSeenFile>;
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

async function writeLastSeen(version: string): Promise<void> {
  try {
    await mkdir(SYNTHRA_DIR, { recursive: true });
    const data: LastSeenFile = { version, updated_at: new Date().toISOString() };
    await writeFile(LAST_SEEN_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/** Find the directory `npm root -g` reports. Used to locate the installed package. */
function npmGlobalRoot(): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => resolve(null));
    proc.on("exit", (code) => {
      if (code !== 0) return resolve(null);
      const out = Buffer.concat(chunks).toString("utf8").trim();
      resolve(out || null);
    });
  });
}

/**
 * Extract the markdown section under `## [version]` (or `## v0.1.11`) from a
 * CHANGELOG body. Returns the bullet/prose content between this version's
 * heading and the next H2, trimmed. Returns null if the version isn't found.
 */
export function extractChangelogSection(text: string, version: string): string | null {
  const escapedVersion = version.replace(/\./g, "\\.");
  // Match: "## [0.1.11]" or "## v0.1.11" or "## 0.1.11", optionally followed by extra text.
  const headingRe = new RegExp(`^##\\s+\\[?v?${escapedVersion}\\]?.*$`, "m");
  const m = headingRe.exec(text);
  if (!m) return null;
  const startBody = m.index + m[0].length;
  const rest = text.slice(startBody);
  const nextHeadingIdx = rest.search(/^##\s+/m);
  const body = nextHeadingIdx < 0 ? rest : rest.slice(0, nextHeadingIdx);
  // Strip horizontal-rule separator lines.
  return body.replace(/^---\s*$/gm, "").trim() || null;
}

async function readInstalledChangelog(): Promise<string | null> {
  const root = await npmGlobalRoot();
  if (!root) return null;
  try {
    return await readFile(join(root, "@jefuriiij", "synthra", "CHANGELOG.md"), "utf8");
  } catch {
    return null;
  }
}

async function printChangelogForVersion(version: string): Promise<void> {
  const md = await readInstalledChangelog();
  if (!md) return;
  const section = extractChangelogSection(md, version);
  if (!section) return;
  log.info("");
  log.info(`What's new in ${version}:`);
  log.info("");
  for (const line of section.split(/\r?\n/)) {
    log.info(`  ${line}`);
  }
  log.info("");
}

/**
 * Compare the running binary's version against the persisted last-seen
 * version. If running > last-seen, print the changelog for the running
 * version and update last-seen. If last-seen is missing (fresh install),
 * silently set it to the current version — new installs don't need a
 * retroactive changelog.
 *
 * Catches users who upgraded via `npm install -g …@latest` outside of
 * Synthra's interactive prompt. Always silent on no-op.
 */
export async function runStartupChangelogCheck(): Promise<void> {
  try {
    const current = await getCurrentVersion();
    const lastSeen = await readLastSeen();
    if (!lastSeen) {
      await writeLastSeen(current);
      return;
    }
    if (isNewer(current, lastSeen)) {
      await printChangelogForVersion(current);
      await writeLastSeen(current);
    }
  } catch {
    // silent
  }
}

/**
 * Ask a yes/no question on stdin/stdout. Returns true only on explicit "y" /
 * "yes". Empty input or anything else returns false.
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

/** Run `npm install -g @jefuriiij/synthra@latest`. Inherits stdio. */
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
 * Interactive update flow. Always hits the registry — no cache. If a newer
 * version exists AND we're on a TTY, prompts the user [y/N]. On 'y', runs
 * npm install, prints the new version's changelog section, and exits with
 * re-run instructions. On 'n' / non-TTY / no update, returns silently so
 * startup continues.
 */
export async function promptForUpdateOrLog(): Promise<void> {
  try {
    const r = await checkForUpdate();
    if (!r.hasUpdate || !r.latest) return;

    // Non-interactive (CI, piped stdin) — log a one-line hint but don't prompt.
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
    log.info(`✓ Updated to ${r.latest}.`);
    await printChangelogForVersion(r.latest);
    await writeLastSeen(r.latest);
    log.info(`Please re-run: syn .`);
    process.exit(0);
  } catch {
    // silent
  }
}
