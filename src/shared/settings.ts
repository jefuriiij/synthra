// User-facing settings, in one small file: ~/.synthra/settings.json.
//
// These used to be environment variables only, which nobody changes casually.
// The file is what the IDE's Settings tab edits (through GET/POST /settings),
// and works the same from a terminal, Cursor, or any other editor — it is
// Synthra's file, not the extension's. An environment variable still wins
// over the file, so CI, tests and power users keep full control; the Settings
// tab shows when one does.
//
// Only what a user would reasonably want to change lives here. The tuning
// knobs (read budgets, debounce, ports) stay environment-only.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SettingKey =
  | "memoryNudgeEvery"
  | "memoryChars"
  | "userChars"
  | "skillApproval"
  | "skillNudgeEvery"
  | "curator"
  | "routeHints"
  | "mapToolsLoaded";

interface Base {
  key: SettingKey;
  /** The environment variable that overrides the file. */
  env: string;
  group: "Memory" | "Learning" | "Dispatcher" | "Code map";
  label: string;
  help: string;
}
export type SettingDef =
  | (Base & { type: "number"; default: number; min: number; max: number; unit?: string })
  | (Base & { type: "boolean"; default: boolean });

export const SETTINGS: readonly SettingDef[] = [
  {
    key: "memoryNudgeEvery",
    env: "SYN_MEMORY_NUDGE_EVERY",
    group: "Memory",
    type: "number",
    default: 10,
    min: 0,
    max: 100,
    unit: "replies",
    label: "Memory nudge",
    help: "After this many Claude replies with no new notes, Claude takes one short extra step to save what it learned. 0 turns the nudge off.",
  },
  {
    key: "memoryChars",
    env: "SYN_MEMORY_CHARS",
    group: "Memory",
    type: "number",
    default: 3500,
    min: 500,
    max: 20000,
    unit: "characters",
    label: "Project memory limit",
    help: "The size limit of .synthra/MEMORY.md. Every session loads this file, so small is better: when it is full, the AI merges old notes instead of adding more. AGENTS.md states it for other AI tools.",
  },
  {
    key: "userChars",
    env: "SYN_USER_CHARS",
    group: "Memory",
    type: "number",
    default: 2000,
    min: 300,
    max: 10000,
    unit: "characters",
    label: "About-you limit",
    help: "The size limit of ~/.synthra/USER.md, the notes about you that every project loads.",
  },
  {
    key: "skillApproval",
    env: "SYN_SKILL_APPROVAL",
    group: "Learning",
    type: "boolean",
    default: true,
    label: "New skills wait for my OK",
    help: "When the AI writes or changes a skill, it waits in the Learning tab until you approve it. Turn this off to let skills go live at once; every change is still recorded and can be seen as a diff. Changes to skills you wrote yourself, and to a skill's scripts, always wait for your OK.",
  },
  {
    key: "skillNudgeEvery",
    env: "SYN_SKILL_NUDGE_EVERY",
    group: "Learning",
    type: "number",
    default: 25,
    min: 0,
    max: 200,
    unit: "tool calls",
    label: "Skill nudge",
    help: "After this much work with no skill saved, Claude takes one short extra step to ask whether the work taught something a skill should hold. It improves an existing skill first and creates a new one only for a new kind of work. 0 turns the nudge off.",
  },
  {
    key: "curator",
    env: "SYN_CURATOR",
    group: "Learning",
    type: "boolean",
    default: true,
    label: "Curator",
    help: "Once a week, tidies the skills Synthra wrote: one unused for 14 days is marked stale, one unused for 30 is moved to an archive (waiting for your OK first, when that is on). Nothing is deleted, pinned skills are never touched, and an archived skill can be restored.",
  },
  {
    key: "routeHints",
    env: "SYN_ROUTE_HINTS",
    group: "Dispatcher",
    type: "boolean",
    default: false,
    label: "Suggest agents in chat",
    help: "Before Claude answers, add a short hint naming the installed agent or skill that fits the task best. Off by default: Synthra still records its suggestions, and route_task answers when asked.",
  },
  {
    key: "mapToolsLoaded",
    env: "SYN_MAP_TOOLS_LOADED",
    group: "Code map",
    type: "boolean",
    default: false,
    label: "Keep map tools loaded",
    help: "Claude Code hides MCP tools until Claude searches for them. On, Synthra's three map tools (graph_continue, graph_read, find_symbol) stay loaded in every session, so Claude can reach for the map first; about 350 tokens per session. The other tools stay hidden either way. Takes effect when Synthra next starts; compare the dashboard's map share before and after.",
  },
];

export type SettingValues = {
  [K in SettingKey]: K extends "routeHints" | "skillApproval" | "curator" | "mapToolsLoaded"
    ? boolean
    : number;
};
export type SettingSource = "default" | "file" | "env";

/** Where the file lives. SYN_SETTINGS moves it — the test suite points it at
 *  a throwaway path, so no test reads or writes the real one. */
export function settingsPath(home: string = homedir()): string {
  return process.env.SYN_SETTINGS || join(home, ".synthra", "settings.json");
}

// ─── reading ────────────────────────────────────────────────────────────────

/** loadConfig() runs on every hook call, so the file is parsed once per
 *  change (mtime + size), not once per read. */
let cache: { path: string; stamp: string; data: Record<string, unknown> } | null = null;

function readFileValues(path: string): Record<string, unknown> {
  let stamp: string;
  try {
    const s = statSync(path);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch {
    return {};
  }
  if (cache && cache.path === path && cache.stamp === stamp) return cache.data;
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A broken file reads as empty: defaults apply, and the next save from
    // the Settings tab writes a valid one.
  }
  cache = { path, stamp, data };
  return data;
}

/** A value as the setting accepts it, or undefined. */
export function coerce(def: SettingDef, raw: unknown): number | boolean | undefined {
  if (def.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return undefined;
  }
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(def.max, Math.max(def.min, Math.round(n)));
}

export interface ResolvedSetting {
  def: SettingDef;
  value: number | boolean;
  source: SettingSource;
}

/** Every setting with its effective value: environment, then file, then default. */
export function resolveSettings(path: string = settingsPath()): ResolvedSetting[] {
  const file = readFileValues(path);
  return SETTINGS.map((def) => {
    const fromEnv = process.env[def.env];
    if (fromEnv !== undefined && fromEnv !== "") {
      const v = coerce(def, fromEnv);
      if (v !== undefined) return { def, value: v, source: "env" as const };
    }
    const fromFile = coerce(def, file[def.key]);
    if (fromFile !== undefined) return { def, value: fromFile, source: "file" as const };
    return { def, value: def.default, source: "default" as const };
  });
}

export function settingValues(path?: string): SettingValues {
  const out = {} as Record<SettingKey, number | boolean>;
  for (const r of resolveSettings(path)) out[r.def.key] = r.value;
  return out as SettingValues;
}

// ─── writing ────────────────────────────────────────────────────────────────

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Set one setting in the file, or remove it (`null` = back to the default).
 * Keys the file holds that this version doesn't know are kept, so a newer
 * Synthra's settings survive an older one saving.
 */
export function writeSetting(
  key: string,
  value: unknown,
  path: string = settingsPath(),
): WriteResult {
  const def = SETTINGS.find((d) => d.key === key);
  if (!def) return { ok: false, error: `Unknown setting: ${key}` };
  const data = { ...readFileValues(path) };
  if (value === null) {
    delete data[key];
  } else {
    const v = coerce(def, value);
    if (v === undefined) {
      return {
        ok: false,
        error:
          def.type === "boolean"
            ? `${def.label} must be on or off.`
            : `${def.label} must be a number from ${def.min} to ${def.max}.`,
      };
    }
    data[key] = v;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  cache = null;
  return { ok: true };
}
