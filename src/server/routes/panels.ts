// GET /panels — everything the IDE extension's sidebar shows, in one read:
//
//   memory        this branch's context entries, each with its stale files
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
} from "../../dashboard/arsenal.js";
import { type DelegationLogEntry, readJsonl } from "../../dashboard/delta.js";
import { type EntryKind, readStore } from "../../memory/context-store.js";
import { resolveActiveBranch } from "../../memory/index.js";
import type { ServerContext } from "../context.js";
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
}

export interface PanelDelegation {
  ts: string;
  agent: string | null;
  model: string | null;
  /** The short task name Claude gave the helper (Stop hook 0.33+). */
  description: string | null;
  session_id?: string;
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
  const [memory, capabilities, agents] = await Promise.all([
    readMemory(ctx).catch((err): PanelsPayload["memory"] => ({
      branch: "",
      store_path: "",
      context_md_path: "",
      unreadable: err instanceof Error ? err.message : String(err),
      entries: [],
    })),
    readCapabilities(ctx, opts),
    readAgents(ctx, now),
  ]);
  return {
    version: PANELS_VERSION,
    project_root: ctx.paths.projectRoot,
    memory,
    capabilities,
    agents,
  };
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

async function readCapabilities(
  ctx: ServerContext,
  opts: PanelsOptions,
): Promise<PanelsPayload["capabilities"]> {
  try {
    if (opts.fresh) clearArsenalCache();
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
    return {
      skills: toPanel("skills", data.skills),
      agents: toPanel("agents", data.agents),
      mcp: toPanel("mcp", data.mcp),
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
