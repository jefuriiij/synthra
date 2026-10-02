// GET /overview: the dashboard's report card. Five questions, one payload:
//
//   health    is Synthra working in each project? (when each hook last ran,
//             whether its hook scripts are current, a plain-words problem)
//   finding   is it helping? (how Claude found code: the map, whole files or
//             a search, and the terminal searches the map could have answered)
//   learning  skills Claude wrote, for the dashboard's project and global
//   memory    MEMORY.md, USER.md and the session notes, and the reminders
//   cost      spend at API prices, the model mix, the priciest replies
//
// Everything is read from files Synthra already writes, so the page works for
// a project whose server is not running. Health and finding cover every
// registered project; learning and memory, the project the dashboard runs for.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { hooksState, type HooksState } from "../hooks/installer.js";
import { curatorStatus, readUsage } from "../learn/curator.js";
import { readStore } from "../memory/context-store.js";
import { resolveActiveBranch } from "../memory/index.js";
import { knowledgeLocation, readKnowledge } from "../memory/knowledge.js";
import { fileHash } from "../scanner/hash.js";
import { type HookName, readHeartbeat } from "../server/heartbeat.js";
import { readLearning } from "../server/routes/learning.js";
import type { NudgeLogEntry } from "../server/routes/nudge.js";
import { resolvePaths, sameRoot, type SynthraPaths } from "../shared/paths.js";
import { estimateCostUsd } from "../shared/pricing.js";
import { listProjects } from "../shared/project-registry.js";
import { type ProjectFiles, loadProjectFiles, readJsonl } from "./delta.js";

const DAY = 24 * 60 * 60 * 1000;

/** Synthra tools that look code up, as opposed to remembering or routing. */
export const LOOKUP_TOOLS = new Set([
  "graph_read",
  "graph_continue",
  "find_symbol",
  "call_path",
  "blast_radius",
  "dead_code",
  "duplicate_symbols",
]);

/** Sessions started this long after the last logged reply: something stopped. */
const STALL_MS = 2 * DAY;
/** ...but only for a project in use lately. */
const RECENT_MS = 14 * DAY;
/** Hooks written this long after the last start were fixed on purpose (Fix
 *  hooks, or `syn .` by hand), not by the start itself, which writes them
 *  within seconds. */
const FIXED_AFTER_MS = 5 * 60 * 1000;

export type Fix = "hooks";

export interface ProjectHealth {
  path: string;
  name: string;
  /** The version of the Synthra server that last ran here, when known. */
  version?: string;
  /** ISO time each hook last ran. From heartbeat.json (0.34+), else from the
   *  logs each hook writes (no "start" then). */
  hooks: Partial<Record<HookName, string>>;
  /** "newer": a newer Synthra wrote them; this dashboard won't touch them. */
  hooks_state: HooksState | "newer";
  /** When the code map was last built. */
  map_built_at?: string;
  /** Plain words, when something needs a look. */
  problem?: string;
  fix?: Fix;
  /** Plain words, when nothing is wrong but something is still to be seen. */
  note?: string;
}

export interface FindingWeek {
  /** ISO start of the 7-day bucket. */
  start: string;
  map: number;
  files: number;
  search: number;
}

export interface Finding {
  /** Lookups answered from Synthra's map: its tools, and searches it stopped. */
  map: number;
  /** Whole files read: the Read tool and `cat`-style terminal reads. */
  files: number;
  /** Searches that ran: terminal searches, and Grep or Glob let through. */
  search: number;
  terminal: number;
  /** Terminal commands the map could have answered. */
  missed: number;
  missed_examples: { tool: string; text: string }[];
  /** The last four weeks, oldest first, whatever the window. */
  weeks: FindingWeek[];
  /** False until a Stop hook that counts Read calls (0.34+) has logged. */
  reads_counted: boolean;
}

export interface LearningCard {
  live: number;
  waiting: number;
  stale: number;
  archived: number;
  most_used: { name: string; scope: string; uses: number }[];
  never_used: string[];
  reminders: number;
  proposed: number;
  kept: number;
}

export interface KnowledgeCard {
  exists: boolean;
  entries: number;
  chars: number;
  limit: number;
  changed_at?: string;
}

export interface MemoryCard {
  project: KnowledgeCard;
  user: KnowledgeCard;
  notes: number;
  stale_notes: number;
  reminders: number;
  saves: number;
}

export interface CostCard {
  spend: number;
  previous: number;
  replies: number;
  /** Cost per model family. */
  models: Record<string, number>;
  priciest: { ts: string; project: string; model: string; cost: number }[];
}

export interface OverviewData {
  days: number;
  generated_at: string;
  project: { path: string; name: string };
  health: ProjectHealth[];
  finding: Finding;
  learning: LearningCard | null;
  memory: MemoryCard | null;
  cost: CostCard;
}

/** -1, 0 or 1, comparing dotted versions numerically ("0.34.0" > "0.9.1"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

const at = (ts: string | undefined): number => (ts ? Date.parse(ts) : Number.NaN);
const inWindow = (ts: string | undefined, from: number, to: number): boolean => {
  const t = at(ts);
  return Number.isFinite(t) && t >= from && t <= to;
};
const tokenTs = (t: { ts?: string; written_at?: string }) => t.ts ?? t.written_at;

async function mtime(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

const latest = (...xs: (string | undefined)[]): string | undefined =>
  xs
    .filter((x): x is string => Boolean(x))
    .sort()
    .pop();

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The one problem worth saying about a project, if any. Pure, for tests. */
export function diagnose(
  h: Pick<ProjectHealth, "hooks" | "hooks_state">,
  lastSeen: string | undefined,
  now: number,
  /** When the hook scripts were last written. */
  hooksAt?: string,
): Pick<ProjectHealth, "problem" | "fix" | "note"> {
  if (h.hooks_state === "missing") {
    return { problem: "The hooks are missing, so Synthra can't see the chats here.", fix: "hooks" };
  }
  if (h.hooks_state === "outdated") {
    return {
      problem: "The hooks are from an older Synthra. Old hooks can stop working without any sign.",
      fix: "hooks",
    };
  }
  const started = latest(h.hooks.start, lastSeen);
  const replied = h.hooks.reply;
  const s = at(started);
  if (Number.isFinite(s) && now - s < RECENT_MS) {
    const r = at(replied);
    const stalled = !Number.isFinite(r) || s - r > STALL_MS;
    // Fixed since the last start: only the next reply can tell.
    if (stalled && at(hooksAt) - s > FIXED_AFTER_MS) {
      return {
        note: `Hooks fixed ${fmtDay(hooksAt as string)}. The next reply here will confirm they work.`,
      };
    }
    if (!Number.isFinite(r)) {
      return {
        problem: `Synthra started here on ${fmtDay(started as string)}, but no reply was ever logged.`,
        fix: "hooks",
      };
    }
    if (s - r > STALL_MS) {
      return {
        problem: `Synthra started here on ${fmtDay(started as string)}, but no reply was logged since ${fmtDay(replied as string)}.`,
        fix: "hooks",
      };
    }
  }
  return {};
}

async function projectHealth(
  root: string,
  name: string,
  lastSeen: string | undefined,
  version: string,
  now: number,
): Promise<ProjectHealth | null> {
  const paths = resolvePaths(root);
  // A project Synthra was removed from (or never scanned) has nothing to show.
  if (!(await mtime(paths.graphDir))) return null;

  const [beat, state, hooksAt, mapAt, replyLog, gateLog, bashLog, routeLog] = await Promise.all([
    readHeartbeat(paths.heartbeat),
    hooksState(paths),
    mtime(
      join(
        paths.claudeHooksDir,
        process.platform === "win32" ? "synthra-stop.ps1" : "synthra-stop.sh",
      ),
    ),
    mtime(paths.infoGraph),
    mtime(paths.tokenLog),
    mtime(paths.gateLog),
    mtime(paths.bashLog),
    mtime(paths.routeLog),
  ]);
  const hooks: ProjectHealth["hooks"] = {
    reply: latest(beat?.hooks.reply, replyLog),
    tools: latest(beat?.hooks.tools, gateLog, bashLog),
    prompt: latest(beat?.hooks.prompt, routeLog),
    ...(beat?.hooks.start ? { start: beat.hooks.start } : {}),
  };
  for (const k of Object.keys(hooks) as HookName[]) if (!hooks[k]) delete hooks[k];
  const hooks_state: ProjectHealth["hooks_state"] =
    beat?.version && compareVersions(beat.version, version) > 0 ? "newer" : state;
  const health: ProjectHealth = {
    path: root,
    name,
    ...(beat?.version ? { version: beat.version } : {}),
    hooks,
    hooks_state,
    ...(mapAt ? { map_built_at: mapAt } : {}),
  };
  return { ...health, ...diagnose(health, lastSeen, now, hooksAt) };
}

/** How Claude found code across these projects. Pure, for tests. */
export function computeFinding(projects: ProjectFiles[], from: number, now: number): Finding {
  const weekStarts = [3, 2, 1, 0].map((i) => now - (i + 1) * 7 * DAY);
  const weeks: FindingWeek[] = weekStarts.map((s) => ({
    start: new Date(s).toISOString(),
    map: 0,
    files: 0,
    search: 0,
  }));
  const f: Finding = {
    map: 0,
    files: 0,
    search: 0,
    terminal: 0,
    missed: 0,
    missed_examples: [],
    weeks,
    reads_counted: false,
  };
  const add = (ts: string | undefined, kind: "map" | "files" | "search", n = 1) => {
    if (n <= 0) return;
    const t = at(ts);
    if (!Number.isFinite(t) || t > now) return;
    if (t >= from) f[kind] += n;
    const w = weekStarts.findIndex((s) => t >= s && t < s + 7 * DAY);
    if (w >= 0) (weeks[w] as FindingWeek)[kind] += n;
  };

  const missed: { ts: string; tool: string; text: string }[] = [];
  for (const p of projects) {
    for (const t of p.tools) if (LOOKUP_TOOLS.has(t.tool)) add(t.ts, "map");
    for (const g of p.gates) add(g.ts, g.decision === "block" ? "map" : "search");
    for (const t of p.tokens) {
      if (typeof t.read_calls === "number") {
        f.reads_counted = true;
        add(tokenTs(t), "files", t.read_calls);
      }
    }
    for (const b of p.bash) {
      add(b.ts, b.kind === "read" ? "files" : "search");
      if (!inWindow(b.ts, from, now)) continue;
      f.terminal += 1;
      if (b.avoidable) {
        f.missed += 1;
        missed.push({ ts: b.ts, tool: b.tool, text: (b.query ?? b.command ?? "").slice(0, 80) });
      }
    }
  }
  f.missed_examples = missed
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 4)
    .map(({ tool, text }) => ({ tool, text }));
  return f;
}

function family(model: string): string {
  const m = model.toLowerCase();
  for (const f of ["fable", "opus", "sonnet", "haiku"]) if (m.includes(f)) return f;
  return "other";
}

/** Spend in the window, the one before it, models and priciest replies. */
export function computeCost(projects: ProjectFiles[], from: number, now: number): CostCard {
  const span = now - from;
  const cost: CostCard = { spend: 0, previous: 0, replies: 0, models: {}, priciest: [] };
  const all: CostCard["priciest"] = [];
  for (const p of projects) {
    for (const t of p.tokens) {
      const ts = tokenTs(t);
      const usd = estimateCostUsd(t);
      if (inWindow(ts, from, now)) {
        cost.spend += usd;
        cost.replies += 1;
        const fam = family(t.model ?? "");
        cost.models[fam] = (cost.models[fam] ?? 0) + usd;
        all.push({ ts: ts as string, project: p.name, model: t.model ?? "", cost: usd });
      } else if (inWindow(ts, from - span, from)) {
        cost.previous += usd;
      }
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  cost.spend = round(cost.spend);
  cost.previous = round(cost.previous);
  for (const k of Object.keys(cost.models)) cost.models[k] = round(cost.models[k] ?? 0);
  cost.priciest = all
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3)
    .map((x) => ({ ...x, cost: round(x.cost) }));
  return cost;
}

async function learningCard(
  paths: SynthraPaths,
  nudges: NudgeLogEntry[],
  from: number,
  now: number,
): Promise<LearningCard> {
  const [learning, usage, curator] = await Promise.all([
    readLearning(paths, now),
    readUsage(paths.skillState),
    curatorStatus(paths, now),
  ]);
  const used = learning.learned
    .map((s) => ({ name: s.name, scope: s.scope, uses: usage[s.path]?.uses ?? 0 }))
    .filter((s) => s.uses > 0)
    .sort((a, b) => b.uses - a.uses);
  const agentChange = (a: string) => a === "create" || a === "patch" || a === "edit";
  const recent = learning.recent.filter((e) => inWindow(e.ts, from, now));
  return {
    live: Math.max(0, learning.learned.length - curator.stale.length),
    waiting: learning.pending.length,
    stale: curator.stale.length,
    archived: curator.archived.length,
    most_used: used.slice(0, 4),
    never_used: learning.learned
      .filter((s) => !(usage[s.path]?.uses ?? 0))
      .map((s) => s.name)
      .slice(0, 6),
    reminders: nudges.filter((n) => n.kind !== "memory").length,
    proposed:
      recent.filter((e) => e.actor === "agent" && agentChange(e.action)).length +
      recent.filter((e) => e.action === "reject").length +
      learning.pending.filter((p) => inWindow(p.ts, from, now)).length,
    kept: recent.filter((e) => e.actor === "agent" && agentChange(e.action)).length,
  };
}

async function knowledgeCard(paths: SynthraPaths, t: "project" | "user"): Promise<KnowledgeCard> {
  const { path, limit } = knowledgeLocation(paths, t);
  const [k, changed] = await Promise.all([readKnowledge(t, path, limit), mtime(path)]);
  return {
    exists: k.exists,
    entries: k.entries.length,
    chars: k.chars,
    limit: k.limit,
    ...(changed ? { changed_at: changed } : {}),
  };
}

async function memoryCard(
  paths: SynthraPaths,
  nudges: NudgeLogEntry[],
  tools: ProjectFiles["tools"],
  from: number,
  now: number,
): Promise<MemoryCard> {
  const [project, user, branch] = await Promise.all([
    knowledgeCard(paths, "project"),
    knowledgeCard(paths, "user"),
    resolveActiveBranch(paths),
  ]);
  const store = await readStore(branch.paths.contextStore);
  const entries = store.status === "ok" ? store.entries : [];
  // A note is out of date when a file it was saved against changed since.
  // Hash just those files: the code map is too big to load per poll.
  const hashes = new Map<string, string | null>();
  const hashOf = async (rel: string) => {
    if (!hashes.has(rel)) {
      const text = await readFile(join(paths.projectRoot, rel), "utf8").catch(() => null);
      hashes.set(rel, text === null ? null : fileHash(text));
    }
    return hashes.get(rel);
  };
  let stale = 0;
  for (const e of entries) {
    for (const a of e.anchors ?? []) {
      if ((await hashOf(a.path)) !== a.hash) {
        stale += 1;
        break;
      }
    }
  }
  return {
    project,
    user,
    notes: entries.length,
    stale_notes: stale,
    reminders: nudges.filter((n) => n.kind !== "skill").length,
    saves: tools.filter((t) => t.tool === "memory" && inWindow(t.ts, from, now)).length,
  };
}

export async function computeOverview(
  activePaths: SynthraPaths,
  opts: { days: number; version: string; now?: number },
): Promise<OverviewData> {
  const now = opts.now ?? Date.now();
  const from = now - opts.days * DAY;
  const root = activePaths.projectRoot;
  const name = root.split(/[/\\]/).filter(Boolean).pop() ?? root;

  const registered = await listProjects();
  const all = registered.map((p) => ({ path: p.path, name: p.name, last_seen: p.last_seen }));
  if (!all.some((p) => sameRoot(p.path, root))) all.unshift({ path: root, name, last_seen: "" });

  const [health, files] = await Promise.all([
    Promise.all(
      all.map((p) => projectHealth(p.path, p.name, p.last_seen || undefined, opts.version, now)),
    ),
    Promise.all(all.map((p) => loadProjectFiles(p.path, p.name, p.last_seen || null))),
  ]);
  const active = files.find((f) => sameRoot(f.path, root));
  const nudges = (await readJsonl<NudgeLogEntry>(activePaths.nudgeLog)).filter((n) =>
    inWindow(n.ts, from, now),
  );

  const [learning, memory] = await Promise.all([
    learningCard(activePaths, nudges, from, now).catch(() => null),
    memoryCard(activePaths, nudges, active?.tools ?? [], from, now).catch(() => null),
  ]);

  return {
    days: opts.days,
    generated_at: new Date(now).toISOString(),
    project: { path: root, name },
    health: health.filter((h): h is ProjectHealth => h !== null),
    finding: computeFinding(files, from, now),
    learning,
    memory,
    cost: computeCost(files, from, now),
  };
}
