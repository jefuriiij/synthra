// Scans the user's Claude Code "arsenal" — installed skills, subagents, and MCP
// servers — across project, personal (~/.claude), and plugin scopes, so the
// dashboard can show what's available without dropping to the CLI.
//
// This reads Claude Code's own on-disk layout (NOT Synthra's graph):
//   skills   ~/.claude/skills/<name>/SKILL.md, <project>/.claude/skills/…, plugin skills/
//   agents   ~/.claude/agents/*.md, <project>/.claude/agents/*.md, plugin agents/
//   mcp      <project>/.mcp.json, ~/.claude.json mcpServers, plugin .mcp.json
//   plugins  ~/.claude/plugins/installed_plugins.json (index) + settings.json enabledPlugins
//
// Security: MCP configs frequently carry auth headers/env tokens. We emit ONLY
// name / type / url(query stripped) / command — headers, env, and args are
// dropped so nothing secret reaches the dashboard.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type ArsenalScope = "project" | "personal" | "plugin";

/** Which list an item lives in — doubles as the Arsenal's tab id. */
export type ArsenalKind = "skills" | "agents" | "mcp";

export interface ArsenalItem {
  name: string;
  description: string;
  scope: ArsenalScope;
  /** Plugin name when scope === "plugin". */
  source?: string;
  /** Plugin items: enabled state from settings.json; undefined = always-on (own files). */
  enabled?: boolean;
  /** Command pack this item belongs to (e.g. "impeccable"). Set on BOTH the
   *  pack's own skill and every member — the UI groups on `pack:<pack>`. */
  pack?: string;
  /** Set ONLY on pack members: the bare sub-command ("polish"). Its presence is
   *  what distinguishes a member from the pack's parent skill. */
  pack_command?: string;
  /** The standalone shortcut pinned for this pack member, e.g. "/distill".
   *  Deliberately NOT `pack_command`: that field excludes an item from the
   *  Dispatcher, and a pinned command is a real, separately installed skill. */
  pinned_as?: string;
  /** Set ONLY when a skill declares `user-invocable: false` — i.e. the user
   *  CANNOT type it as a slash command and Claude loads it on its own. Absent
   *  means invocable, which is Claude Code's default when the key is omitted
   *  (68 of 68 plugin skills omit it), so encoding the exception as presence
   *  beats stamping every item with `true`. */
  invocable?: boolean;
  /** Kind-specific extras: agents {tools,model}; skills {argument_hint,user_invocable}; mcp {type,url}. */
  meta?: Record<string, string>;
}

export interface ArsenalData {
  skills: ArsenalItem[];
  agents: ArsenalItem[];
  mcp: ArsenalItem[];
  /** `skills` includes expanded pack members (see PACKS), so it can exceed the
   *  number of SKILL.md files on disk. */
  counts: { skills: number; agents: number; mcp: number; plugins: number };
  scanned_at: string;
}

/** One item's full source — the payload behind the detail modal. */
export interface ArsenalDetail {
  kind: ArsenalKind;
  name: string;
  scope: ArsenalScope;
  source?: string;
  enabled?: boolean;
  pack?: string;
  pack_command?: string;
  /** Unclipped — the DESC_MAX clip on list items is lossy. "" when none. */
  description: string;
  /** Home-collapsed display path (`~/.claude/skills/impeccable/SKILL.md`).
   *  Absent for MCP items, which are config entries with no file of their own. */
  path?: string;
  /** Every frontmatter key, nested ones dotted. Absent for MCP items and for
   *  files with no frontmatter block. */
  frontmatter?: Record<string, string>;
  /** Raw markdown below the frontmatter, capped at BODY_MAX. Absent for MCP
   *  items and when the file vanished between scan and request. */
  body?: string;
  /** Full pre-cap length of `body`. */
  body_chars?: number;
  truncated: boolean;
  meta?: Record<string, string>;
}

export interface ArsenalDetailQuery {
  kind: ArsenalKind;
  scope: ArsenalScope;
  name: string;
  source?: string;
}

export function isArsenalKind(v: unknown): v is ArsenalKind {
  return v === "skills" || v === "agents" || v === "mcp";
}

export function isArsenalScope(v: unknown): v is ArsenalScope {
  return v === "project" || v === "personal" || v === "plugin";
}

const DESC_MAX = 300;
const TOOLS_MAX = 200;
/** Frontmatter blocks longer than this are truncated — a bound, not a limit
 *  anyone should hit (the longest real SKILL.md frontmatter is ~30 lines). */
const FM_MAX_LINES = 200;
/** Detail bodies are capped here. Generous on purpose: the largest real skill
 *  file (framer-code-components) is ~64 KB, and this is a localhost payload. */
const BODY_MAX = 200_000;

interface PackSpec {
  /** Skill-relative JSON manifest: `{ "<command>": { description, argumentHint } }`. */
  manifest: string;
  /** Skill-relative dir holding `<command>.md` for each manifest key. */
  dir: string;
}

/**
 * Skills that ship a command pack we expand into individually browsable items.
 *
 * Narrow by design: keyed on the skill's resolved name, with the manifest and
 * reference dir as data, so a second pack is a table entry rather than new
 * code. Anything not listed here scans exactly as before.
 *
 * Membership comes from the manifest, never from globbing the dir — impeccable
 * ships 34 `reference/*.md` files of which only 23 are commands (the rest are
 * platform variants and infra docs like `hooks.md`), and the manifest is the
 * only thing that knows the difference.
 */
const PACKS: Record<string, PackSpec> = {
  impeccable: { manifest: "scripts/command-metadata.json", dir: "reference" },
};

/**
 * A pack can "pin" one of its commands: it writes a tiny standalone skill whose
 * body just redirects to the pack, because a real SKILL.md is the only way into
 * Claude Code's slash-command menu. Those files carry a marker comment naming
 * the pack that owns them, e.g. `<!-- impeccable-pinned-skill -->`.
 *
 * We fold each one into the pack member it shortcuts, so a command shows up
 * once — as its playbook — carrying the short name you can actually type.
 * Matching on the marker ONLY: a personal skill that merely happens to be
 * called `polish` must never be swallowed into a pack.
 */
const PIN_MARKER = /<!--\s*([a-z0-9][a-z0-9-]*)-pinned-skill\s*-->/i;

/** A pinned shortcut found during the scan, held until its pack member exists. */
interface PinnedShortcut {
  pack: string;
  command: string;
  item: ArsenalItem;
  file: string;
  description: string;
}

interface PackEntry {
  description?: string;
  argumentHint?: string;
}

/** Server-only sidecar for one item: where it came from, and its untruncated
 *  description. Never serialized to the client. */
interface ArsenalSource {
  file: string;
  description: string;
}

type SourceIndex = Map<string, ArsenalSource>;

/** Identity of an item within its list. NUL-separated because names come from
 *  user-authored frontmatter — no name can contain NUL, so none can forge
 *  another item's key. */
function itemKey(kind: ArsenalKind, scope: string, source: string | undefined, name: string) {
  return [kind, scope, source ?? "", name].join("\u0000");
}

function indexSource(
  index: SourceIndex,
  kind: ArsenalKind,
  item: ArsenalItem,
  file: string,
  description: string,
): void {
  const k = itemKey(kind, item.scope, item.source, item.name);
  // First write wins, matching the skills dedupe — otherwise a symlinked
  // duplicate could point the modal at file B while the description came from A.
  if (!index.has(k)) index.set(k, { file, description });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Full-fidelity frontmatter reader — no dependency (Synthra stays lean). Reads
 * the leading `--- … ---` block and returns every key plus the markdown body
 * that follows it. Beyond `parseFrontmatter`'s column-0 pairs it also handles:
 *
 *   - block scalars (`description: |`, `|-`, `>`, `>-`) — the indented lines
 *     below become the value (folded to spaces for `>`, newlines kept for `|`)
 *   - nested keys, flattened dotted (`metadata:` + `  version: 2.9.1` →
 *     `"metadata.version"`), so a detail view can show them
 *   - block sequences (`- a` / `- b` → `"a, b"`)
 *
 * The block is bounded to FM_MAX_LINES so a hostile file can't build an
 * unbounded key map. Keys stay verbatim (e.g. "argument-hint").
 */
export function readFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = md.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return { fm: {}, body: md.replace(/^﻿/, "") };
  const lines = (m[1] ?? "").split(/\r?\n/).slice(0, FM_MAX_LINES);
  const body = m[2] ?? "";
  const fm: Record<string, string> = {};
  // Indent-tracking stack of ancestor keys, so `metadata:` + two-space
  // `version:` flattens to "metadata.version".
  const parents: { indent: number; key: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^(\s*)([A-Za-z][\w.-]*):[ \t]?(.*)$/);
    if (!kv) continue;
    const indent = (kv[1] ?? "").length;
    const key = kv[2] ?? "";
    if (!key) continue;
    let val = kv[3] ?? "";

    while (parents.length && (parents[parents.length - 1]?.indent ?? 0) >= indent) parents.pop();
    const path = [...parents.map((p) => p.key), key].join(".");

    // Block scalar: the value is the indented run of lines beneath it.
    const scalar = val.match(/^([|>])[-+]?\s*$/);
    if (scalar) {
      const fold = scalar[1] === ">";
      const raw: string[] = [];
      // The block's own indent comes from its first content line — dedent by
      // that, not by the key's indent, or every line keeps a stray prefix.
      let blockIndent = -1;
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        const nextIndent = next.match(/^\s*/)?.[0].length ?? 0;
        if (next.trim() && nextIndent <= indent) break;
        i += 1;
        if (next.trim() && blockIndent < 0) blockIndent = nextIndent;
        raw.push(next);
      }
      while (raw.length && !(raw[raw.length - 1] ?? "").trim()) raw.pop();
      const cut = blockIndent < 0 ? indent + 1 : blockIndent;
      const buf = raw.map((l) => l.slice(cut).trimEnd());
      fm[path] = fold ? buf.join(" ").replace(/\s+/g, " ").trim() : buf.join("\n").trim();
      continue;
    }

    // Quoted value that doesn't close on this line → consume until the closer.
    if ((val.startsWith('"') && !/[^\\]"\s*$/.test(val.slice(1))) || val === '"') {
      const buf = [val];
      while (i + 1 < lines.length && !/"\s*$/.test(buf[buf.length - 1] ?? "")) {
        i += 1;
        buf.push(lines[i] ?? "");
      }
      val = buf.join(" ");
    }

    val = val
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();

    // `key:` with nothing after it opens either a nested map or a sequence.
    if (!val) {
      const seq: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        if (!next.trim()) break;
        const dash = next.match(/^(\s*)-\s+(.*)$/);
        if (!dash || (dash[1] ?? "").length <= indent) break;
        seq.push((dash[2] ?? "").trim().replace(/^["']|["']$/g, ""));
        j += 1;
      }
      if (seq.length) {
        fm[path] = seq.join(", ");
        i = j - 1;
        continue;
      }
      parents.push({ indent, key });
      continue;
    }

    fm[path] = val;
  }
  return { fm, body };
}

/**
 * Frontmatter as the scanner has always seen it: top-level keys only. Nested
 * keys stay hidden so a `metadata: { model }` block can't be mistaken for a
 * top-level `model:`. Callers wanting the full picture use `readFrontmatter`.
 */
export function parseFrontmatter(md: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readFrontmatter(md).fm).filter(([k]) => !k.includes(".")),
  );
}

function skillItem(
  fm: Record<string, string>,
  fallbackName: string,
  scope: ArsenalScope,
  source?: string,
): ArsenalItem {
  const meta: Record<string, string> = {};
  if (fm["argument-hint"]) meta.argument_hint = fm["argument-hint"];
  if (fm["user-invocable"]) meta.user_invocable = fm["user-invocable"];
  // Frontmatter is a string here, so a truthiness test would read the literal
  // "false" as opting IN — the exact inversion of what the author asked for.
  const optedOut = fm["user-invocable"]?.trim().toLowerCase() === "false";
  return {
    name: fm.name || fallbackName,
    description: clip(fm.description || "", DESC_MAX),
    scope,
    ...(source ? { source } : {}),
    ...(optedOut ? { invocable: false } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

function agentItem(
  fm: Record<string, string>,
  fallbackName: string,
  scope: ArsenalScope,
  source?: string,
): ArsenalItem {
  const meta: Record<string, string> = {};
  if (fm.tools) meta.tools = clip(fm.tools, TOOLS_MAX);
  if (fm.model) meta.model = fm.model;
  return {
    name: fm.name || fallbackName,
    description: clip(fm.description || "", DESC_MAX),
    scope,
    ...(source ? { source } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

/**
 * Turn a pack skill's command manifest into browsable sibling items, so
 * `/impeccable polish` is findable by typing "polish" instead of hiding inside
 * one card's body.
 *
 * Members are named `"<pack> <command>"` — space-joined, which keeps them
 * unique against the scope:source:name dedupe, searchable by the bare command,
 * and (since " " sorts below every letter) clustered directly after the parent
 * with no change to sortItems.
 *
 * A missing or corrupt manifest degrades to the parent skill alone.
 */
async function expandPack(
  skillDir: string,
  parent: ArsenalItem,
  spec: PackSpec,
  index: SourceIndex,
): Promise<ArsenalItem[]> {
  const manifest = await readJson<Record<string, PackEntry>>(join(skillDir, spec.manifest));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const refDir = join(skillDir, spec.dir);
  const present = new Set(await listNames(refDir)); // one readdir, not N reads
  const out: ArsenalItem[] = [];
  for (const [command, entry] of Object.entries(manifest)) {
    if (!command || !present.has(`${command}.md`)) continue; // stale manifest key
    const description = typeof entry?.description === "string" ? entry.description : "";
    if (!description) continue;
    const item: ArsenalItem = {
      name: `${parent.name} ${command}`,
      description: clip(description, DESC_MAX),
      scope: parent.scope,
      ...(parent.source ? { source: parent.source } : {}),
      ...(parent.enabled !== undefined ? { enabled: parent.enabled } : {}),
      pack: parent.name,
      pack_command: command,
      ...(entry?.argumentHint ? { meta: { argument_hint: entry.argumentHint } } : {}),
    };
    out.push(item);
    indexSource(index, "skills", item, join(refDir, `${command}.md`), description);
  }
  return out;
}

async function scanSkillsDir(
  dir: string,
  scope: ArsenalScope,
  source: string | undefined,
  out: ArsenalItem[],
  index: SourceIndex,
  pins: PinnedShortcut[],
): Promise<void> {
  for (const name of await listNames(dir)) {
    const file = join(dir, name, "SKILL.md");
    const md = await readText(file);
    if (md === null) continue; // not a skill dir (or broken symlink) — skip
    const fm = parseFrontmatter(md);
    const item = skillItem(fm, name, scope, source);

    // Free detection: `md` is the whole file and parseFrontmatter discards the
    // body, so this costs one substring scan over an already-resident string.
    const pinned = PIN_MARKER.exec(md);
    if (pinned?.[1]) {
      // Held back, not emitted — mergePins decides whether it becomes a card of
      // its own (pack missing) or folds into its member (the normal case).
      pins.push({
        pack: pinned[1].toLowerCase(),
        command: item.name,
        item,
        file,
        description: fm.description ?? "",
      });
      continue;
    }

    const spec = PACKS[item.name];
    if (spec) item.pack = item.name; // the pack's own row header
    out.push(item);
    indexSource(index, "skills", item, file, fm.description ?? "");
    if (spec) out.push(...(await expandPack(join(dir, name), item, spec, index)));
  }
}

/**
 * Fold each pinned shortcut into the pack member it points at, so a command
 * appears once instead of twice (`distill` under Personal AND `impeccable
 * distill` under Impeccable).
 *
 * A pin whose member isn't there — pack uninstalled, or a stale pin for a
 * command that no longer exists — is emitted as an ordinary skill rather than
 * dropped. Losing a real installed file would be worse than showing a redirect.
 *
 * Matching is scoped: `pin.mjs` writes into the same skills dir as the pack it
 * belongs to, so a personal pin must not attach to a project pack.
 */
function mergePins(
  skills: ArsenalItem[],
  pins: PinnedShortcut[],
  index: SourceIndex,
): ArsenalItem[] {
  if (!pins.length) return skills;
  const members = new Map<string, ArsenalItem>();
  for (const s of skills) {
    if (s.pack && s.pack_command) {
      members.set(`${s.scope}\u0000${s.source ?? ""}\u0000${s.pack}\u0000${s.pack_command}`, s);
    }
  }

  const orphans: ArsenalItem[] = [];
  for (const pin of pins) {
    const key = `${pin.item.scope}\u0000${pin.item.source ?? ""}\u0000${pin.pack}\u0000${pin.command}`;
    const member = members.get(key);
    if (member) {
      member.pinned_as = `/${pin.command}`;
      continue;
    }
    orphans.push(pin.item);
    indexSource(index, "skills", pin.item, pin.file, pin.description);
  }
  return orphans.length ? [...skills, ...orphans] : skills;
}

async function scanAgentsDir(
  dir: string,
  scope: ArsenalScope,
  source: string | undefined,
  out: ArsenalItem[],
  index: SourceIndex,
): Promise<void> {
  for (const file of await listNames(dir)) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    const md = await readText(path);
    if (md === null) continue;
    const fm = parseFrontmatter(md);
    const item = agentItem(fm, basename(file, ".md"), scope, source);
    out.push(item);
    indexSource(index, "agents", item, path, fm.description ?? "");
  }
}

/** Redacted MCP server entries — name/type/url only, never headers/env/args. */
function mcpItemsFrom(
  json: unknown,
  scope: ArsenalScope,
  source: string | undefined,
): ArsenalItem[] {
  if (!json || typeof json !== "object") return [];
  const record = json as Record<string, unknown>;
  // Either { mcpServers: {...} } or a bare { name: {type,url} } map.
  const servers =
    record.mcpServers && typeof record.mcpServers === "object"
      ? (record.mcpServers as Record<string, unknown>)
      : record;
  const items: ArsenalItem[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const cfg = raw as Record<string, unknown>;
    const type = typeof cfg.type === "string" ? cfg.type : cfg.command ? "stdio" : "http";
    const url =
      typeof cfg.url === "string"
        ? cfg.url.split("?")[0]
        : typeof cfg.command === "string"
          ? cfg.command
          : "";
    const meta: Record<string, string> = { type };
    if (url) meta.url = url;
    items.push({ name, description: "", scope, ...(source ? { source } : {}), meta });
  }
  return items;
}

interface InstalledEntry {
  scope?: string;
  installPath?: string;
  version?: string;
}

const SCOPE_ORDER: Record<ArsenalScope, number> = { project: 0, personal: 1, plugin: 2 };

function sortItems(items: ArsenalItem[]): ArsenalItem[] {
  return items.sort((a, b) => {
    if (a.scope !== b.scope) return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    const sa = a.source ?? "";
    const sb = b.source ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// `sources` rides on the cache entry rather than living in its own module-level
// Map: one object, one lifetime, replaced atomically at the end of a scan — so
// the path index can never drift out of sync with the data it describes.
let cache: { key: string; at: number; data: ArsenalData; sources: SourceIndex } | null = null;
const CACHE_TTL_MS = 15_000;

export async function computeArsenal(
  projectRoot: string,
  homeDir = homedir(),
): Promise<ArsenalData> {
  const key = `${projectRoot}\u0000${homeDir}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.data;

  const homeClaude = join(homeDir, ".claude");
  const projClaude = join(projectRoot, ".claude");

  const skills: ArsenalItem[] = [];
  const agents: ArsenalItem[] = [];
  const mcp: ArsenalItem[] = [];
  const sources: SourceIndex = new Map();
  const pins: PinnedShortcut[] = [];

  // --- own files: project, then personal ---
  await scanSkillsDir(join(projClaude, "skills"), "project", undefined, skills, sources, pins);
  await scanSkillsDir(join(homeClaude, "skills"), "personal", undefined, skills, sources, pins);
  await scanAgentsDir(join(projClaude, "agents"), "project", undefined, agents, sources);
  await scanAgentsDir(join(homeClaude, "agents"), "personal", undefined, agents, sources);
  mcp.push(...mcpItemsFrom(await readJson(join(projectRoot, ".mcp.json")), "project", undefined));
  mcp.push(
    ...mcpItemsFrom(
      (await readJson<Record<string, unknown>>(join(homeDir, ".claude.json")))?.mcpServers,
      "personal",
      undefined,
    ),
  );

  // --- plugins: installed_plugins.json gives exact installPath per plugin ---
  // installed_plugins.json is `{ version, plugins: { "<key>": [entries] } }`
  // (v2); tolerate an older flat `{ "<key>": [entries] }` shape too.
  const installedRaw = await readJson<Record<string, unknown>>(
    join(homeClaude, "plugins", "installed_plugins.json"),
  );
  const pluginsMap = (installedRaw?.plugins ?? installedRaw ?? {}) as Record<
    string,
    InstalledEntry[]
  >;
  const settings = await readJson<{ enabledPlugins?: Record<string, boolean> }>(
    join(homeClaude, "settings.json"),
  );
  const enabledMap = settings?.enabledPlugins ?? {};
  let pluginCount = 0;
  for (const [pluginKey, entries] of Object.entries(pluginsMap)) {
    const entry = Array.isArray(entries) ? entries[0] : undefined;
    if (!entry?.installPath) continue;
    pluginCount += 1;
    const pluginName = pluginKey.split("@")[0];
    const enabled = enabledMap[pluginKey] !== false;
    const root = entry.installPath;

    // Layouts vary: some plugins keep agents/skills in agents/ + skills/
    // subdirs (feature-dev), others at the plugin root listed in plugin.json
    // (voltagent). Take the UNION of both, deduped by file path.
    const manifest = await readJson<{ agents?: string[]; skills?: string[] }>(
      join(root, ".claude-plugin", "plugin.json"),
    );

    const agentFiles = new Set<string>();
    for (const f of await listNames(join(root, "agents"))) {
      if (f.endsWith(".md")) agentFiles.add(join(root, "agents", f));
    }
    for (const rel of manifest?.agents ?? []) agentFiles.add(join(root, rel));
    const pAgents: ArsenalItem[] = [];
    for (const file of agentFiles) {
      const md = await readText(file);
      if (md === null) continue;
      const fm = parseFrontmatter(md);
      const item = agentItem(fm, basename(file, ".md"), "plugin", pluginName);
      pAgents.push(item);
      indexSource(sources, "agents", item, file, fm.description ?? "");
    }

    const skillMds = new Set<string>();
    for (const name of await listNames(join(root, "skills"))) {
      skillMds.add(join(root, "skills", name, "SKILL.md"));
    }
    for (const rel of manifest?.skills ?? []) {
      skillMds.add(rel.endsWith(".md") ? join(root, rel) : join(root, rel, "SKILL.md"));
    }
    const pSkills: ArsenalItem[] = [];
    for (const md of skillMds) {
      const text = await readText(md);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const item = skillItem(fm, basename(dirname(md)), "plugin", pluginName);
      pSkills.push(item);
      indexSource(sources, "skills", item, md, fm.description ?? "");
    }

    const pMcp = mcpItemsFrom(await readJson(join(root, ".mcp.json")), "plugin", pluginName);
    for (const it of [...pSkills, ...pAgents, ...pMcp]) it.enabled = enabled;
    skills.push(...pSkills);
    agents.push(...pAgents);
    mcp.push(...pMcp);
  }

  // Fold pinned shortcuts into their pack members before dedupe/sort, so a
  // command is one card carrying the short name you can type.
  const withPins = mergePins(skills, pins, sources);

  // dedupe skills by scope+source+name (symlink/dir overlaps)
  const seen = new Set<string>();
  const dedupedSkills = withPins.filter((s) => {
    const k = `${s.scope}:${s.source ?? ""}:${s.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const data: ArsenalData = {
    skills: sortItems(dedupedSkills),
    agents: sortItems(agents),
    mcp: sortItems(mcp),
    counts: {
      skills: dedupedSkills.length,
      agents: agents.length,
      mcp: mcp.length,
      plugins: pluginCount,
    },
    scanned_at: new Date(now).toISOString(),
  };
  cache = { key, at: now, data, sources };
  return data;
}

/** `C:\Users\Jeff\.claude\…` → `~/.claude/…` for display. */
function collapseHome(path: string, homeDir: string): string {
  const normal = path.replace(/\\/g, "/");
  const home = homeDir.replace(/\\/g, "/").replace(/\/$/, "");
  return normal.startsWith(`${home}/`) ? `~${normal.slice(home.length)}` : normal;
}

/**
 * Everything about ONE item, including the full file body — the payload behind
 * the detail modal.
 *
 * Security invariant: this function performs NO path construction from `query`.
 * Every path it reads comes out of the scan's own `sources` index, so a caller
 * cannot steer it at a file the scanner didn't already walk. MCP items are
 * never indexed, which is why `.mcp.json` / `~/.claude.json` / `settings.json`
 * (the files most likely to sit next to auth tokens) are unreachable here.
 */
export async function computeArsenalDetail(
  projectRoot: string,
  query: ArsenalDetailQuery,
  homeDir = homedir(),
): Promise<ArsenalDetail | null> {
  // Always go through computeArsenal: on a hit we reuse the memo's index, on a
  // miss we build both. There is no "index not populated yet" state to handle.
  const data = await computeArsenal(projectRoot, homeDir);
  const item = data[query.kind].find(
    (i) =>
      i.name === query.name && i.scope === query.scope && (i.source ?? "") === (query.source ?? ""),
  );
  if (!item) return null;

  const base: ArsenalDetail = {
    kind: query.kind,
    name: item.name,
    scope: item.scope,
    ...(item.source ? { source: item.source } : {}),
    ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
    ...(item.pack ? { pack: item.pack } : {}),
    ...(item.pack_command ? { pack_command: item.pack_command } : {}),
    description: item.description,
    truncated: false,
    ...(item.meta ? { meta: item.meta } : {}),
  };
  // MCP entries are config, not files — nothing more to read.
  if (query.kind === "mcp") return base;

  const src = cache?.sources.get(itemKey(query.kind, item.scope, item.source, item.name));
  if (!src) return base;
  base.path = collapseHome(src.file, homeDir);
  base.description = src.description.trim();

  const text = await readText(src.file);
  // Resolved but unreadable (moved since the scan): a half-populated modal
  // beats a 404 that reads like a bug.
  if (text === null) return base;

  const { fm, body } = readFrontmatter(text);
  if (Object.keys(fm).length) base.frontmatter = fm;
  base.body_chars = body.length;
  base.body = body.slice(0, BODY_MAX);
  base.truncated = body.length > BODY_MAX;
  return base;
}
