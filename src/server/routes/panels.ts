// GET /panels — everything the IDE extension's sidebar shows, in one read:
//
//   memory        MEMORY.md and USER.md, and this branch's context entries,
//                 each with its stale files
//   capabilities  the arsenal (skills, agents, MCP servers), plus the file each
//                 item came from so a click in the editor can open it
//   agents        the helpers Claude started in the last week (the Stop hook's
//                 delegation log)
//
// One route, not three: the panels refresh together (a file watcher fires, the
// server restarts), and one round trip keeps them consistent with each other.
// Each section fails on its own — a damaged context store must not blank the
// Capabilities panel.

import {
  type ArsenalItem,
  type ArsenalKind,
  type ArsenalScope,
  arsenalItemFile,
  clearArsenalCache,
  computeArsenal,
  readSkillLock,
} from "../../dashboard/arsenal.js";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { STALE_DAYS, type SkillAge, readPins, readUsage, skillAges } from "../../learn/curator.js";
import { listSkills, listSupportFiles, skillLockPath } from "../../learn/skills.js";
import { pathKey } from "../../shared/paths.js";
import { type DelegationLogEntry, readJsonl } from "../../dashboard/delta.js";
import { type EntryKind, readStore } from "../../memory/context-store.js";
import { resolveActiveBranch } from "../../memory/index.js";
import { knowledgeLocation, readKnowledge } from "../../memory/knowledge.js";
import type { ServerContext } from "../context.js";
import { type LearningSection, readLearning } from "./learning.js";
import { type SettingsView, settingsView } from "./settings.js";
import { staleAnchorPaths } from "../mcp.js";

/** Bumped on a breaking change to the payload. The extension checks it, so an
 *  older server and a newer extension (or the reverse) say so instead of
 *  rendering half a tree. */
export const PANELS_VERSION = 1;

/** The Agents panel looks back this far. */
const AGENTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AGENTS_MAX = 100;

export interface PanelMemoryEntry {
  kind: EntryKind;
  content: string;
  tags: string[];
  files: string[];
  date: string;
  /** Anchored files whose content changed since the entry was stored. */
  stale: string[];
}

export interface PanelItem {
  name: string;
  description: string;
  scope: ArsenalScope;
  /** Plugin name when scope === "plugin". */
  source?: string;
  enabled?: boolean;
  /** Absolute path of the SKILL.md or agent file. Absent for MCP servers. */
  file?: string;
  /** A command pack's own skill: how many commands it holds. The members
   *  themselves are not listed — fifty `/impeccable:*` rows would bury the rest. */
  commands?: number;
  meta?: Record<string, string>;
  // Skills in the user's own folders (project, personal) only:
  /** Synthra wrote it. */
  synthra?: true;
  /** An installer put it there (npx skills): the repo it came from. */
  third_party?: string;
  /** The skill's folder is a link to this folder. */
  linked_to?: string;
  /** Pinned: the Curator leaves it alone. */
  pinned?: true;
  /** Synthra's skill, unused this many days (14 or more), not pinned. */
  stale_days?: number;
  uses?: number;
  /** ISO time of the last use. */
  last_used?: string;
  /** Support files beside its SKILL.md, relative to its folder (the first 20). */
  files?: string[];
  /** Support files past the first 20. */
  files_more?: number;
  /** In the user's own folders: its files may be opened for editing. */
  editable?: true;
  /** May be deleted (moved to the archive) from the IDE. */
  deletable?: true;
}

export interface PanelDelegation {
  ts: string;
  agent: string | null;
  model: string | null;
  /** The short task name Claude gave the helper (Stop hook 0.33+). */
  description: string | null;
  session_id?: string;
}

export interface PanelKnowledgeFile {
  path: string;
  exists: boolean;
  entries: string[];
  chars: number;
  limit: number;
}

export interface PanelsPayload {
  version: number;
  project_root: string;
  memory: {
    branch: string;
    store_path: string;
    context_md_path: string;
    /** Set when the store couldn't be parsed: empty `entries` then means
     *  "unreadable", not "nothing remembered". */
    unreadable?: string;
    entries: PanelMemoryEntry[];
    /** The two knowledge files every session loads (0.33+). Read apart from
     *  the store, so a damaged store or a git hiccup can't hide them. */
    files?: { project: PanelKnowledgeFile; user: PanelKnowledgeFile };
  };
  capabilities: {
    skills: PanelItem[];
    agents: PanelItem[];
    mcp: PanelItem[];
    scanned_at: string;
    error?: string;
  };
  agents: {
    since: string;
    delegations: PanelDelegation[];
  };
  /** The Settings tab (0.33+); changes go to POST /settings. */
  settings?: SettingsView;
  /** The Learning tab (0.33+). */
  learning?: LearningSection;
}

export interface PanelsOptions {
  /** Rescan the arsenal instead of using its 15s memo. */
  fresh?: boolean;
  /** Tests point the arsenal scan at a fake home. */
  homeDir?: string;
  now?: number;
}

export async function handlePanels(
  ctx: ServerContext,
  opts: PanelsOptions = {},
): Promise<PanelsPayload> {
  const now = opts.now ?? Date.now();
  // Once per refresh: skillAges writes firstSeen as it goes, and both the
  // Capabilities rows and the Curator card need it.
  const ages = skillAges(ctx.paths, now).catch((): SkillAge[] => []);
  const [memory, files, capabilities, agents, learning] = await Promise.all([
    readMemory(ctx).catch((err): PanelsPayload["memory"] => ({
      branch: "",
      store_path: "",
      context_md_path: "",
      unreadable: err instanceof Error ? err.message : String(err),
      entries: [],
    })),
    readKnowledgeFiles(ctx),
    readCapabilities(ctx, opts, ages),
    readAgents(ctx, now),
    readLearning(ctx.paths, now, { ages }).catch(() => undefined),
  ]);
  return {
    version: PANELS_VERSION,
    project_root: ctx.paths.projectRoot,
    memory: { ...memory, files },
    capabilities,
    agents,
    settings: settingsView(),
    ...(learning ? { learning } : {}),
  };
}

async function readKnowledgeFiles(
  ctx: ServerContext,
): Promise<{ project: PanelKnowledgeFile; user: PanelKnowledgeFile }> {
  const read = async (t: "project" | "user"): Promise<PanelKnowledgeFile> => {
    const { path, limit } = knowledgeLocation(ctx.paths, t);
    const f = await readKnowledge(t, path, limit);
    return { path: f.path, exists: f.exists, entries: f.entries, chars: f.chars, limit: f.limit };
  };
  const [project, user] = await Promise.all([read("project"), read("user")]);
  return { project, user };
}

async function readMemory(ctx: ServerContext): Promise<PanelsPayload["memory"]> {
  const active = await resolveActiveBranch(ctx.paths);
  const base = {
    branch: active.branch,
    store_path: active.paths.contextStore,
    context_md_path: active.paths.contextMd,
  };
  const read = await readStore(active.paths.contextStore);
  if (read.status === "corrupt") return { ...base, unreadable: read.error, entries: [] };
  return {
    ...base,
    entries: read.entries.map((e) => ({
      kind: e.type,
      content: e.content,
      tags: e.tags ?? [],
      files: e.files ?? [],
      date: e.date,
      stale: staleAnchorPaths(e, ctx.graph),
    })),
  };
}

/** What Synthra knows about the skills in the user's own folders, keyed by
 *  pathKey of the SKILL.md. Read before the arsenal scan, so nothing awaits
 *  between the scan and arsenalItemFile. */
interface SkillFacts {
  learned: Set<string>;
  pins: Set<string>;
  usage: Map<string, { lastUsed?: string; uses?: number }>;
  stale: Map<string, number>;
  locks: { project: Map<string, string>; personal: Map<string, string> };
}

async function skillFacts(ctx: ServerContext, ages: Promise<SkillAge[]>): Promise<SkillFacts> {
  const state = ctx.paths.skillState;
  const [skills, pins, usage, ageList, project, personal] = await Promise.all([
    listSkills(ctx.paths),
    readPins(state),
    readUsage(state),
    ages,
    readSkillLock(skillLockPath(ctx.paths, "project")),
    readSkillLock(skillLockPath(ctx.paths, "global")),
  ]);
  return {
    learned: new Set(skills.filter((s) => s.learned).map((s) => pathKey(s.path))),
    pins: new Set([...pins].map(pathKey)),
    usage: new Map(Object.entries(usage).map(([p, u]) => [pathKey(p), u])),
    stale: new Map(
      ageList
        .filter((a) => a.daysUnused >= STALE_DAYS && !a.pinned)
        .map((a) => [pathKey(a.skill.path), a.daysUnused]),
    ),
    locks: { project, personal },
  };
}

/** Support-file lists by skill folder, for the last scan only: walking ninety
 *  skill folders on every panel refresh would be wasted work. */
let filesMemo: { scannedAt: string; byDir: Map<string, { files: string[]; more: number }> } = {
  scannedAt: "",
  byDir: new Map(),
};
const FILES_SHOWN = 20;

async function supportFor(dir: string, scannedAt: string) {
  if (filesMemo.scannedAt !== scannedAt) filesMemo = { scannedAt, byDir: new Map() };
  const key = pathKey(dir);
  let hit = filesMemo.byDir.get(key);
  if (!hit) {
    hit = await listSupportFiles(dir, FILES_SHOWN);
    filesMemo.byDir.set(key, hit);
  }
  return hit;
}

/** A skill row from the user's own folders, with what the IDE needs to offer
 *  on it: who owns it, whether it is linked, pinned or stale, its use, and the
 *  files beside its SKILL.md. */
async function withFacts(
  item: PanelItem,
  facts: SkillFacts,
  scannedAt: string,
): Promise<PanelItem> {
  if (!item.file || (item.scope !== "project" && item.scope !== "personal")) return item;
  const key = pathKey(item.file);
  const dir = dirname(item.file);
  const linked = await lstat(dir).then(
    async (s) => (s.isSymbolicLink() ? realpath(dir) : undefined),
    () => undefined,
  );
  const synthra = facts.learned.has(key);
  const lock = item.scope === "project" ? facts.locks.project : facts.locks.personal;
  const third = synthra
    ? undefined
    : (lock.get(item.name) ?? (linked ? lock.get(basename(linked)) : undefined));
  const u = facts.usage.get(key);
  const stale = facts.stale.get(key);
  const { files, more } = await supportFor(dir, scannedAt);
  return {
    ...item,
    ...(synthra ? { synthra: true as const } : {}),
    ...(third ? { third_party: third } : {}),
    ...(linked ? { linked_to: linked } : {}),
    ...(facts.pins.has(key) ? { pinned: true as const } : {}),
    ...(stale !== undefined ? { stale_days: stale } : {}),
    ...(u?.uses ? { uses: u.uses } : {}),
    ...(u?.lastUsed ? { last_used: u.lastUsed } : {}),
    ...(files.length ? { files } : {}),
    ...(more ? { files_more: more } : {}),
    editable: true,
    ...(third ? {} : { deletable: true as const }),
  };
}

async function readCapabilities(
  ctx: ServerContext,
  opts: PanelsOptions,
  ages: Promise<SkillAge[]>,
): Promise<PanelsPayload["capabilities"]> {
  try {
    if (opts.fresh) clearArsenalCache();
    const facts = await skillFacts(ctx, ages);
    const data = opts.homeDir
      ? await computeArsenal(ctx.paths.projectRoot, opts.homeDir)
      : await computeArsenal(ctx.paths.projectRoot);
    // No await between the scan and these lookups: arsenalItemFile reads the
    // index of the last scan, and another request could start a new one.
    const toPanel = (kind: ArsenalKind, list: ArsenalItem[]) => {
      const commands = new Map<string, number>();
      for (const i of list) {
        if (i.pack && i.pack_command) commands.set(i.pack, (commands.get(i.pack) ?? 0) + 1);
      }
      return list
        .filter((i) => !i.pack_command)
        .map((i): PanelItem => {
          const file = arsenalItemFile(kind, i);
          const n = i.pack ? commands.get(i.pack) : undefined;
          return {
            name: i.name,
            description: i.description,
            scope: i.scope,
            ...(i.source ? { source: i.source } : {}),
            ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
            ...(file ? { file } : {}),
            ...(n ? { commands: n } : {}),
            ...(i.meta ? { meta: i.meta } : {}),
          };
        });
    };
    const skills = toPanel("skills", data.skills);
    const agents = toPanel("agents", data.agents);
    const mcp = toPanel("mcp", data.mcp);
    return {
      skills: await Promise.all(skills.map((s) => withFacts(s, facts, data.scanned_at))),
      agents,
      mcp,
      scanned_at: data.scanned_at,
    };
  } catch (err) {
    return {
      skills: [],
      agents: [],
      mcp: [],
      scanned_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readAgents(ctx: ServerContext, now: number): Promise<PanelsPayload["agents"]> {
  const since = now - AGENTS_WINDOW_MS;
  const log = await readJsonl<DelegationLogEntry>(ctx.paths.delegationLog);
  const delegations: PanelDelegation[] = [];
  // The log is append-ordered: walk it backwards for newest first.
  for (let i = log.length - 1; i >= 0 && delegations.length < AGENTS_MAX; i--) {
    const d = log[i];
    if (!d || typeof d.ts !== "string") continue;
    const at = Date.parse(d.ts);
    if (!Number.isFinite(at) || at < since) continue;
    delegations.push({
      ts: d.ts,
      agent: d.agent ?? null,
      model: d.model ?? null,
      description: d.description ?? null,
      ...(d.session_id ? { session_id: d.session_id } : {}),
    });
  }
  return { since: new Date(since).toISOString(), delegations };
}
