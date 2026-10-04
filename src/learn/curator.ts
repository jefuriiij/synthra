// The Curator — Hermes' weekly tidy of the skills it learned, for the skills
// Synthra wrote. Deterministic: no model call, nothing deleted.
//
//   unused 14 days  → stale: listed in the Learning tab, nothing else happens
//   unused 30 days  → archived: the folder moves out of Claude Code's skills
//                     (inside the project for a project skill, so the team
//                     keeps it in git; ~/.synthra/skills/archive for a global
//                     one). With "New skills wait for my OK" on, this is a
//                     proposal the user approves like any other.
//
// "Used" means Claude loaded the skill — the PreToolUse hook sees every Skill
// call (recordUse) — or the skill was created, changed or restored. A skill
// Synthra has no record of (a teammate's, arriving through git) starts its
// clock when the Curator first sees it, so a fresh clone archives nothing.
// Pinned skills are never touched. Only skills carrying Synthra's mark are
// ever looked at.
//
// It runs at most once a week per project, when its server is up, and on
// "Run now". State, in ~/.synthra/skills/: usage.json, pins.json, curator.json.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../shared/config.js";
import { type SynthraPaths, sameRoot } from "../shared/paths.js";
import { log } from "../shared/logger.js";
import {
  type Outcome,
  type SkillInfo,
  type SkillScope,
  NAME_RE,
  archiveDirFor,
  findSkill,
  listArchived,
  listPending,
  listSkills,
  newId,
  readLedger,
  skillMdOf,
  submit,
} from "./skills.js";

export const STALE_DAYS = 14;
export const ARCHIVE_DAYS = 30;
export const EVERY_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

// ─── small JSON state files ─────────────────────────────────────────────────

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const v: unknown = JSON.parse(await readFile(path, "utf8"));
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** By skill path: when Claude last loaded it, how often, and when Synthra
 *  first saw it. */
export type Usage = Record<string, { lastUsed?: string; uses?: number; firstSeen?: string }>;

const usageFile = (state: string) => join(state, "usage.json");
const pinsFile = (state: string) => join(state, "pins.json");
const curatorFile = (state: string) => join(state, "curator.json");

/** Every read-modify-write of usage.json goes through here, one at a time, so
 *  a Skill call landing during a Curator pass can't be lost. (One process
 *  per project; two projects racing on the global file can at worst drop one
 *  use, which only makes a skill look a little older.) */
let usageQueue: Promise<unknown> = Promise.resolve();
function withUsage<T>(fn: (u: Usage) => Promise<T> | T, state: string): Promise<T> {
  const run = usageQueue.then(async () => {
    const usage = await readUsage(state);
    const r = await fn(usage);
    await writeJson(usageFile(state), usage);
    return r;
  });
  usageQueue = run.catch(() => undefined);
  return run;
}

/** Fold use counts from a backup in: per skill, the higher count, the later
 *  last use and the earlier first sighting. */
export function mergeUsage(state: string, incoming: Usage): Promise<number> {
  return withUsage((u) => {
    let n = 0;
    for (const [path, b] of Object.entries(incoming)) {
      const a = u[path] ?? {};
      const later = (x?: string, y?: string) => (!x ? y : !y ? x : x > y ? x : y);
      const earlier = (x?: string, y?: string) => (!x ? y : !y ? x : x < y ? x : y);
      const lastUsed = later(a.lastUsed, b.lastUsed);
      const firstSeen = earlier(a.firstSeen, b.firstSeen);
      const uses = Math.max(a.uses ?? 0, b.uses ?? 0);
      u[path] = {
        ...(lastUsed ? { lastUsed } : {}),
        ...(uses ? { uses } : {}),
        ...(firstSeen ? { firstSeen } : {}),
      };
      n++;
    }
    return n;
  }, state);
}

export async function readUsage(state: string): Promise<Usage> {
  return readJson<Usage>(usageFile(state), {});
}

/** Claude loaded this skill (the PreToolUse hook saw a Skill call). */
export async function recordUse(state: string, path: string, now = Date.now()): Promise<void> {
  await withUsage((usage) => {
    const u = usage[path] ?? {};
    usage[path] = { ...u, lastUsed: new Date(now).toISOString(), uses: (u.uses ?? 0) + 1 };
  }, state);
}

/**
 * A skill was used by name: the model's Skill call (PreToolUse) or the user's
 * `/name` (UserPromptSubmit). `raw` may carry a leading slash and arguments.
 * Every skill of that name gets the use (when a project and a global skill
 * share a name, Claude Code picks one by its own precedence, and crediting the
 * wrong one would let the Curator archive the one in use). The user's own
 * skills are counted too, for the "used N times" line in the IDE; the Curator
 * still looks only at Synthra's. A namespaced name (`plugin:skill`) is a
 * plugin's, never in these folders.
 */
export async function recordUseByName(paths: SynthraPaths, raw: string, now = Date.now()) {
  const name = raw.trim().replace(/^\//, "").split(/\s/)[0];
  if (!name || name.includes(":") || !NAME_RE.test(name)) return;
  for (const scope of ["project", "global"] as const) {
    const s = await findSkill(paths, name, scope);
    if (s) await recordUse(paths.skillState, s.path, now);
  }
}

export async function readPins(state: string): Promise<Set<string>> {
  const v = await readJson<{ pinned?: unknown }>(pinsFile(state), {});
  return new Set(
    Array.isArray(v.pinned) ? v.pinned.filter((x): x is string => typeof x === "string") : [],
  );
}

/** Pin keeps a skill out of the Curator's hands for good; unpin gives it back. */
export async function setPin(state: string, path: string, on: boolean): Promise<void> {
  const pins = await readPins(state);
  if (on) pins.add(path);
  else pins.delete(path);
  await writeJson(pinsFile(state), { pinned: [...pins].sort() });
}

export interface CuratorRun {
  ranAt: string;
  checked: number;
  stale: number;
  /** Archive proposals made (approval on). */
  proposed: number;
  archived: number;
  /** Skills it couldn't archive (logged), when any. */
  failed?: number;
}

/** Per project: each project's server curates its own project skills (and the
 *  global ones), on its own weekly clock. */
type CuratorState = { runs?: Record<string, CuratorRun> };

export async function lastRun(paths: SynthraPaths): Promise<CuratorRun | undefined> {
  const s = await readJson<CuratorState>(curatorFile(paths.skillState), {});
  return s.runs?.[paths.projectRoot];
}

// ─── how long a skill has gone unused ───────────────────────────────────────

export interface SkillAge {
  skill: SkillInfo;
  /** Last time it was used, created, changed or restored — or first seen. */
  lastActive: number;
  daysUnused: number;
  pinned: boolean;
}

/** Every Synthra skill this project's server looks after: this project's,
 *  and the global ones. */
export async function skillAges(paths: SynthraPaths, now = Date.now()): Promise<SkillAge[]> {
  const [skills, ledger, usage, pins] = await Promise.all([
    listSkills(paths),
    readLedger(paths.skillState),
    readUsage(paths.skillState),
    readPins(paths.skillState),
  ]);
  const touched = new Map<string, number>();
  for (const e of ledger) {
    // Not activity: a proposal turned down, or the archive itself. Except a
    // rejected ARCHIVE — that is the user saying "keep it", which restarts
    // the clock, or the same proposal would be back next week.
    if (e.action === "archive") continue;
    if (e.action === "reject" && e.rejected !== "archive") continue;
    const t = Date.parse(e.ts);
    // A change to a support file is activity for the skill it belongs to.
    const key = skillMdOf(e);
    if (Number.isFinite(t)) touched.set(key, Math.max(touched.get(key) ?? 0, t));
  }
  const unseen: string[] = [];
  const out: SkillAge[] = [];
  for (const s of skills.filter((x) => x.learned)) {
    const u = usage[s.path] ?? {};
    const candidates = [
      touched.get(s.path) ?? 0,
      u.lastUsed ? Date.parse(u.lastUsed) : 0,
      u.firstSeen ? Date.parse(u.firstSeen) : 0,
    ].filter((n) => Number.isFinite(n));
    let lastActive = Math.max(0, ...candidates);
    if (lastActive === 0) {
      // No record at all: start the clock now rather than guess.
      unseen.push(s.path);
      lastActive = now;
    }
    out.push({
      skill: s,
      lastActive,
      daysUnused: Math.floor((now - lastActive) / DAY),
      pinned: pins.has(s.path),
    });
  }
  if (unseen.length) {
    await withUsage((u) => {
      for (const p of unseen) {
        if (!u[p]?.firstSeen) u[p] = { ...u[p], firstSeen: new Date(now).toISOString() };
      }
    }, paths.skillState);
  }
  return out;
}

// ─── the run ────────────────────────────────────────────────────────────────

export interface RunOptions {
  now?: number;
  /** "Run now": ignore the weekly clock (and the on/off setting). */
  force?: boolean;
}

/** One pass. Null when it isn't due (or the Curator is off). */
/** One pass per project at a time: "Run now" clicked twice, or clicked while
 *  the timer runs, joins the pass already going instead of starting a second
 *  one (which would propose the same archive twice). */
const inFlight = new Map<string, Promise<CuratorRun | null>>();

export function runCurator(paths: SynthraPaths, opts: RunOptions = {}): Promise<CuratorRun | null> {
  const running = inFlight.get(paths.projectRoot);
  if (running) return running;
  const run = runOnce(paths, opts).finally(() => inFlight.delete(paths.projectRoot));
  inFlight.set(paths.projectRoot, run);
  return run;
}

async function runOnce(paths: SynthraPaths, opts: RunOptions): Promise<CuratorRun | null> {
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    if (!loadConfig().curator) return null;
    const last = await lastRun(paths);
    if (last && now - Date.parse(last.ranAt) < EVERY_DAYS * DAY) return null;
  }

  const ages = await skillAges(paths, now);
  const waiting = new Set(
    (await listPending(paths.skillState)).filter((p) => p.action === "archive").map((p) => p.path),
  );
  const run: CuratorRun = {
    ranAt: new Date(now).toISOString(),
    checked: ages.length,
    stale: 0,
    proposed: 0,
    archived: 0,
  };

  for (const a of ages) {
    if (a.pinned) continue;
    if (a.daysUnused >= ARCHIVE_DAYS) {
      if (waiting.has(a.skill.path)) continue;
      const text = await readFile(a.skill.path, "utf8").catch(() => null);
      if (text === null) continue;
      // One skill that can't be moved must not stop the pass, or the run
      // would never be recorded and the next tick would fail the same way.
      const o = await submit(paths, {
        id: newId(),
        ts: new Date(now).toISOString(),
        action: "archive",
        scope: a.skill.scope,
        name: a.skill.name,
        path: a.skill.path,
        project: paths.projectRoot,
        before: text,
        after: "",
        reason: `Not used for ${a.daysUnused} days.`,
        archiveTo: archiveDirFor(paths, a.skill.scope, a.skill.name),
      }).catch((err): Outcome => ({ status: "error", error: String(err) }));
      if (o.status === "error") {
        run.failed = (run.failed ?? 0) + 1;
        log.warn(`curator: couldn't archive ${a.skill.path}: ${o.error}`);
      } else if (o.status === "pending") run.proposed += 1;
      else if (o.status === "applied") run.archived += 1;
    } else if (a.daysUnused >= STALE_DAYS) {
      run.stale += 1;
    }
  }

  const s = await readJson<CuratorState>(curatorFile(paths.skillState), {});
  await writeJson(curatorFile(paths.skillState), {
    runs: { ...(s.runs ?? {}), [paths.projectRoot]: run },
  });
  return run;
}

// ─── for the Learning tab ───────────────────────────────────────────────────

export interface CuratorStatus {
  enabled: boolean;
  lastRun?: CuratorRun;
  nextRunAt?: string;
  staleDays: number;
  archiveDays: number;
  /** Synthra skills unused for STALE_DAYS or more, most unused first. */
  stale: {
    name: string;
    scope: SkillScope;
    path: string;
    daysUnused: number;
    pinned: boolean;
  }[];
  pinned: { name: string; scope: SkillScope; path: string }[];
  archived: Awaited<ReturnType<typeof listArchived>>;
}

/** `ages`: the caller's skillAges for this `now`, when it has one. It writes
 *  firstSeen as it goes, so /panels computes it once and shares it. */
export async function curatorStatus(
  paths: SynthraPaths,
  now = Date.now(),
  ages?: Promise<SkillAge[]>,
): Promise<CuratorStatus> {
  const [last, ageList, archived] = await Promise.all([
    lastRun(paths),
    ages ?? skillAges(paths, now),
    listArchived(paths.skillState),
  ]);
  const enabled = loadConfig().curator;
  return {
    enabled,
    ...(last ? { lastRun: last } : {}),
    ...(enabled
      ? {
          nextRunAt: new Date(last ? Date.parse(last.ranAt) + EVERY_DAYS * DAY : now).toISOString(),
        }
      : {}),
    staleDays: STALE_DAYS,
    archiveDays: ARCHIVE_DAYS,
    stale: ageList
      .filter((a) => a.daysUnused >= STALE_DAYS && !a.pinned)
      .sort((a, b) => b.daysUnused - a.daysUnused)
      .map((a) => ({
        name: a.skill.name,
        scope: a.skill.scope,
        path: a.skill.path,
        daysUnused: a.daysUnused,
        pinned: a.pinned,
      })),
    pinned: ageList
      .filter((a) => a.pinned)
      .map((a) => ({ name: a.skill.name, scope: a.skill.scope, path: a.skill.path })),
    archived: archived.filter(
      (x) => x.scope === "global" || sameRoot(x.project, paths.projectRoot),
    ),
  };
}
