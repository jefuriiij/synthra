// Backup and restore of what Synthra keeps on this machine only, for a new
// device: one plain-text JSON file the user can open.
//
// In the backup: the skills for every project that the user or Synthra wrote
// (~/.claude/skills, with their support files; a linked one as a plain copy),
// ~/.synthra/USER.md, settings, favorites, use counts, the archive, and the
// skill history with the texts its diffs show. Installed skills (npx skills)
// go in only as a list, to reinstall from their source; plugin and
// claude.ai-synced skills come back on their own. Project skills and
// .synthra/MEMORY.md travel with each project's git repo.
//
// Restore merges and never overwrites: a skill not on this machine is added;
// the same skill with another text waits in the Learning tab as a change; the
// notes about the user are combined; favorites, use counts, history and the
// archive are joined; settings already set here stay. Paths under the old home
// folder are moved to this one, across Windows, macOS and Linux.

import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { readSkillLock } from "../dashboard/arsenal.js";
import { charCount, parseKnowledge, readKnowledge } from "../memory/knowledge.js";
import { loadConfig } from "../shared/config.js";
import { readJsonFile, updateTextFile, writeJsonAtomic } from "../shared/json-store.js";
import { type SynthraPaths, pathKey } from "../shared/paths.js";
import { settingsPath } from "../shared/settings.js";
import { type Usage, mergeUsage, readPins, readUsage, setPin } from "./curator.js";
import {
  type Proposal,
  type SkillEvent,
  findSkill,
  listSkills,
  newId,
  ownership,
  readLedger,
  skillLockPath,
  submit,
  waitingFor,
} from "./skills.js";

export const BACKUP_FORMAT = "synthra-backup";
export const BACKUP_VERSION = 1;

/** One file of a skill or an archived skill, relative to its folder. Text
 *  stays readable; anything else is base64. */
export interface BackupFile {
  path: string;
  text?: string;
  base64?: string;
}

export interface BackupSkill {
  name: string;
  owner: "synthra" | "user";
  /** It was a link to this folder on the old machine. */
  linkedTo?: string;
  files: BackupFile[];
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  created: string;
  /** The Synthra version that wrote it. */
  synthra: string;
  /** The old home folder: paths under it move to the new one on restore. */
  home: string;
  platform: string;
  skills: BackupSkill[];
  userMemory: string | null;
  settings: Record<string, unknown> | null;
  favorites: string[];
  usage: Usage;
  ledger: SkillEvent[];
  /** The before/after texts the history's diffs show, by hash. */
  blobs: Record<string, string>;
  /** ~/.synthra/skills/archive, folder by folder. */
  archive: { dir: string; files: BackupFile[] }[];
  /** Installed skills (npx skills): reinstalled from their source. */
  installed: { name: string; source: string }[];
}

/** A file bigger than this is left out (skills are text; this is a backup of
 *  notes, not of large assets). */
const FILE_MAX = 1_000_000;
const FOLDER_FILES_MAX = 300;

// ─── reading folders ────────────────────────────────────────────────────────

/** Every file in a folder, relative and with "/", never following a link out
 *  of it, skipping .git, node_modules and half-written temp files. */
async function readFolder(dir: string): Promise<BackupFile[]> {
  const out: BackupFile[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(rel ? join(dir, ...rel.split("/")) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= FOLDER_FILES_MAX) return;
      if (e.name === ".git" || e.name === "node_modules" || e.name.endsWith(".tmp")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 6) await walk(r, depth + 1);
      } else if (e.isFile()) {
        const buf = await readFile(join(dir, ...r.split("/"))).catch(() => null);
        if (!buf || buf.length > FILE_MAX) continue;
        const text = buf.toString("utf8");
        out.push(
          !text.includes(String.fromCharCode(0)) && Buffer.from(text, "utf8").equals(buf)
            ? { path: r, text }
            : { path: r, base64: buf.toString("base64") },
        );
      }
    }
  };
  await walk("", 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const readText = (p: string) => readFile(p, "utf8").catch(() => null);

// ─── backup ─────────────────────────────────────────────────────────────────

export async function createBackup(
  paths: SynthraPaths,
  { version, home = homedir() }: { version: string; home?: string },
): Promise<Backup> {
  const state = paths.skillState;
  const skills: BackupSkill[] = [];
  for (const s of (await listSkills(paths)).filter((x) => x.scope === "global")) {
    const own = await ownership(paths, s);
    if (own.owner === "third_party") continue;
    skills.push({
      name: s.name,
      owner: own.owner,
      ...(own.linkedTo ? { linkedTo: own.linkedTo } : {}),
      files: await readFolder(dirname(s.path)),
    });
  }

  const blobs: Record<string, string> = {};
  for (const f of await readdir(join(state, "blobs")).catch(() => [] as string[])) {
    const sha = f.replace(/\.md$/, "");
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const text = await readText(join(state, "blobs", f));
    if (text !== null) blobs[sha] = text;
  }

  const archive: Backup["archive"] = [];
  for (const d of await readdir(join(state, "archive")).catch(() => [] as string[])) {
    const files = await readFolder(join(state, "archive", d));
    if (files.length) archive.push({ dir: d, files });
  }

  const settings = await readJsonFile<Record<string, unknown>>(settingsPath(home));
  const lock = await readSkillLock(skillLockPath(paths, "global"));

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created: new Date().toISOString(),
    synthra: version,
    home,
    platform: process.platform,
    skills,
    userMemory: await readText(paths.userMemory),
    settings: settings.status === "ok" ? settings.data : null,
    favorites: [...(await readPins(state))],
    usage: await readUsage(state),
    ledger: await readLedger(state),
    blobs,
    archive,
    installed: [...lock.entries()].map(([name, source]) => ({ name, source })),
  };
}

// ─── restore ────────────────────────────────────────────────────────────────

export interface RestoreReport {
  /** Skills that were not on this machine: added. */
  added: string[];
  /** Skills that differ from this machine's: a change waits in Learning. */
  waiting: string[];
  /** Skills already the same here. */
  same: string[];
  skipped: { name: string; why: string }[];
  /** Notes about the user that were new here. */
  userNotes: number;
  /** USER.md is now over its size limit: ask Claude to tidy it. */
  userOverLimit: boolean;
  settings: string[];
  favorites: number;
  history: number;
  archived: number;
  /** Installed skills that aren't here: the command that brings each back. */
  reinstall: { name: string; source: string; command: string }[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._ -]*$/;
/** Installed skills may carry a namespace ("react:components"). */
const INSTALLED_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_RE = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|https:\/\/[A-Za-z0-9./_-]+)$/;

/** A relative "a/b/c.md" that stays inside its folder, or null. */
function safeRel(rel: unknown): string | null {
  if (typeof rel !== "string" || !rel || rel.length > 300) return null;
  const segs = rel.split("/");
  if (segs.length > 7) return null;
  for (const s of segs) {
    if (!SEGMENT_RE.test(s) || s === "." || s === ".." || s.endsWith(".")) return null;
  }
  return rel;
}

/** Why a file can't be a valid backup, or null. */
export function checkBackup(b: unknown): string | null {
  const x = b as Partial<Backup> | null;
  if (!x || typeof x !== "object" || x.format !== BACKUP_FORMAT) {
    return "That isn't a Synthra backup file.";
  }
  if (typeof x.version !== "number" || x.version > BACKUP_VERSION) {
    return "This backup was made by a newer Synthra. Update Synthra, then restore it.";
  }
  if (!Array.isArray(x.skills) || typeof x.home !== "string") return "The backup file is damaged.";
  return null;
}

/** A path from the old machine, moved under this machine's home folder when it
 *  was under the old one. Windows and POSIX separators both count. */
export function remapPath(p: string, oldHome: string, newHome: string): string {
  const norm = (s: string) => s.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  const from = norm(oldHome);
  const path = norm(p);
  const ci = /^[A-Za-z]:\//.test(from);
  const starts = ci
    ? path.toLowerCase().startsWith(`${from.toLowerCase()}/`)
    : path.startsWith(`${from}/`);
  if (!from || !starts) return p;
  return join(newHome, ...path.slice(from.length + 1).split("/"));
}

/** Write a backup file under `root`, refusing any path that would leave it. */
async function writeInto(root: string, f: BackupFile): Promise<boolean> {
  const rel = safeRel(f.path);
  if (!rel) return false;
  const abs = join(root, ...rel.split("/"));
  if (!resolve(abs).startsWith(resolve(root) + sep)) return false;
  await mkdir(dirname(abs), { recursive: true });
  if (typeof f.text === "string") await writeFile(abs, f.text, "utf8");
  else if (typeof f.base64 === "string") await writeFile(abs, Buffer.from(f.base64, "base64"));
  else return false;
  return true;
}

const exists = (p: string) =>
  readdir(p).then(
    () => true,
    () =>
      readFile(p).then(
        () => true,
        () => false,
      ),
  );

export async function restoreBackup(
  paths: SynthraPaths,
  b: Backup,
  { home = homedir() }: { home?: string } = {},
): Promise<RestoreReport> {
  const state = paths.skillState;
  const move = (p: string) => remapPath(p, b.home, home);
  const day = b.created.slice(0, 10);
  const report: RestoreReport = {
    added: [],
    waiting: [],
    same: [],
    skipped: [],
    userNotes: 0,
    userOverLimit: false,
    settings: [],
    favorites: 0,
    history: 0,
    archived: 0,
    reinstall: [],
  };

  // Skills.
  for (const s of b.skills ?? []) {
    if (!s || typeof s.name !== "string" || !NAME_RE.test(s.name) || !Array.isArray(s.files)) {
      report.skipped.push({ name: String(s?.name ?? "?"), why: "not a valid skill in the backup" });
      continue;
    }
    const dir = join(paths.globalSkillsDir, s.name);
    const here = await findSkill(paths, s.name, "global");
    if (!here) {
      if (await exists(dir)) {
        report.skipped.push({
          name: s.name,
          why: "a folder of that name is here without a SKILL.md",
        });
        continue;
      }
      let n = 0;
      for (const f of s.files) if (await writeInto(dir, f)) n++;
      if (n) report.added.push(s.name);
      else report.skipped.push({ name: s.name, why: "no files could be restored" });
      continue;
    }
    const own = await ownership(paths, here);
    if (own.owner === "third_party") {
      report.skipped.push({ name: s.name, why: `installed here from ${own.source}` });
      continue;
    }
    // The same skill with other texts: each difference waits for the user.
    let changes = 0;
    let unsure = 0;
    for (const f of s.files) {
      const rel = safeRel(f.path);
      if (!rel) continue;
      const abs = join(dir, ...rel.split("/"));
      if (typeof f.text !== "string") {
        // Binary: only added when missing; a proposal holds text only.
        if (!(await exists(abs))) await writeInto(dir, f);
        continue;
      }
      const current = await readText(abs);
      if (current === f.text) continue;
      if (await waitingFor(state, abs)) {
        unsure++;
        continue;
      }
      const isSkill = rel === "SKILL.md";
      const p: Proposal = {
        id: newId(),
        ts: new Date().toISOString(),
        action: current === null ? "create" : "edit",
        scope: "global",
        name: s.name,
        path: abs,
        ...(isSkill ? {} : { file: rel }),
        ...(own.owner === "user" ? { owner: "user" as const } : {}),
        ...(own.linkedTo ? { linkedTo: own.linkedTo } : {}),
        project: paths.projectRoot,
        before: current,
        after: f.text,
        reason: `From your backup of ${day}.`,
      };
      await submit(paths, p, { mustWait: true });
      changes++;
    }
    if (changes) report.waiting.push(s.name);
    else if (unsure)
      report.skipped.push({ name: s.name, why: "a change to it already waits for your OK" });
    else report.same.push(s.name);
  }

  // The notes about the user: the backup's that aren't here yet, appended.
  if (typeof b.userMemory === "string" && b.userMemory.trim()) {
    const limit = loadConfig().userChars;
    const key = (e: string) => e.replace(/\s+/g, " ").trim().toLowerCase();
    const incoming = parseKnowledge(b.userMemory).entries;
    await mkdir(dirname(paths.userMemory), { recursive: true });
    await updateTextFile(paths.userMemory, (current) => {
      if (current === null) {
        report.userNotes = incoming.length;
        return b.userMemory;
      }
      const have = new Set(parseKnowledge(current).entries.map(key));
      const add = incoming.filter((e) => !have.has(key(e)));
      report.userNotes = add.length;
      if (!add.length) return null;
      const bullets = add.map((e) => `- ${e.split("\n").join("\n  ")}`).join("\n");
      return `${current.replace(/\s+$/, "")}\n${bullets}\n`;
    });
    const f = await readKnowledge("user", paths.userMemory, limit);
    report.userOverLimit = charCount(f.entries) > limit;
  }

  // Settings: one already set here stays; a missing one comes from the backup.
  if (b.settings && typeof b.settings === "object") {
    const path = settingsPath(home);
    const now = await readJsonFile<Record<string, unknown>>(path);
    const mine = now.status === "ok" ? now.data : {};
    const merged = { ...mine };
    for (const [k, v] of Object.entries(b.settings)) {
      if (!(k in mine)) {
        merged[k] = v;
        report.settings.push(k);
      }
    }
    if (report.settings.length) await writeJsonAtomic(path, merged);
  }

  // Favorites and use counts, under this machine's home folder.
  const pins = await readPins(state);
  const pinned = new Set([...pins].map(pathKey));
  for (const f of b.favorites ?? []) {
    if (typeof f !== "string") continue;
    const p = move(f);
    if (pinned.has(pathKey(p))) continue;
    await setPin(state, p, true);
    pinned.add(pathKey(p));
    report.favorites++;
  }
  if (b.usage && typeof b.usage === "object") {
    const moved: Usage = {};
    for (const [p, u] of Object.entries(b.usage))
      if (u && typeof u === "object") moved[move(p)] = u;
    await mergeUsage(state, moved);
  }

  // The archive: folders that aren't here yet.
  for (const a of b.archive ?? []) {
    if (!a || typeof a.dir !== "string" || !NAME_RE.test(a.dir) || !Array.isArray(a.files))
      continue;
    const dir = join(state, "archive", a.dir);
    if (await exists(dir)) continue;
    let n = 0;
    for (const f of a.files) if (await writeInto(dir, f)) n++;
    if (n) report.archived++;
  }

  // History: the texts its diffs show, then the events not known here, kept in
  // time order so "recent" stays recent.
  for (const [sha, text] of Object.entries(b.blobs ?? {})) {
    if (!/^[0-9a-f]{40}$/.test(sha) || typeof text !== "string") continue;
    const p = join(state, "blobs", `${sha}.md`);
    if (await exists(p)) continue;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, "utf8");
  }
  const incoming = (b.ledger ?? []).filter(
    (e): e is SkillEvent => !!e && typeof e.id === "string" && typeof e.ts === "string",
  );
  if (incoming.length) {
    await mkdir(state, { recursive: true });
    await updateTextFile(join(state, "ledger.jsonl"), (current) => {
      const lines = (current ?? "").split("\n").filter(Boolean);
      const have = new Set(
        lines.flatMap((l) => {
          try {
            const e = JSON.parse(l) as SkillEvent;
            return [`${e.id}:${e.action}`];
          } catch {
            return [];
          }
        }),
      );
      const add = incoming
        .filter((e) => !have.has(`${e.id}:${e.action}`))
        .map((e) => ({
          ...e,
          path: move(e.path),
          ...(e.archivePath ? { archivePath: move(e.archivePath) } : {}),
        }));
      report.history = add.length;
      if (!add.length) return null;
      const all = [
        ...lines.map((l) => ({ l, ts: tsOf(l) })),
        ...add.map((e) => ({ l: JSON.stringify(e), ts: e.ts })),
      ].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
      return `${all.map((x) => x.l).join("\n")}\n`;
    });
  }

  // Installed skills that aren't here: the installer brings them back.
  const lock = await readSkillLock(skillLockPath(paths, "global"));
  for (const i of b.installed ?? []) {
    if (!i || !INSTALLED_RE.test(String(i.name)) || !SOURCE_RE.test(String(i.source))) continue;
    if (lock.has(i.name) || (await findSkill(paths, i.name, "global"))) continue;
    report.reinstall.push({
      name: i.name,
      source: i.source,
      command: `npx skills add ${i.source} -g -s ${i.name}`,
    });
  }
  return report;
}

function tsOf(line: string): string {
  try {
    return String((JSON.parse(line) as { ts?: string }).ts ?? "");
  } catch {
    return "";
  }
}

/** "synthra-backup-2026-10-04.json". */
export function backupFileName(now = new Date()): string {
  return `synthra-backup-${now.toISOString().slice(0, 10)}.json`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The report in plain words, one line each (the terminal and the IDE). */
/** `commands`: list each reinstall command (the terminal); the IDE has a
 *  button for them instead. */
export function restoreSummary(r: RestoreReport, { commands = true } = {}): string[] {
  const lines: string[] = [];
  if (r.added.length) lines.push(`Added ${plural(r.added.length, "skill")}: ${r.added.join(", ")}`);
  if (r.waiting.length) {
    lines.push(
      `${plural(r.waiting.length, "skill")} differ from this machine's: the backup's version waits for your OK in the Learning tab (${r.waiting.join(", ")})`,
    );
  }
  if (r.same.length) lines.push(`${plural(r.same.length, "skill")} already the same here`);
  for (const s of r.skipped) lines.push(`Skipped ${s.name}: ${s.why}`);
  if (r.userNotes) lines.push(`USER.md: ${plural(r.userNotes, "note")} added`);
  if (r.userOverLimit) lines.push("USER.md is over its size limit now: ask Claude to tidy it");
  if (r.settings.length) lines.push(`Settings taken from the backup: ${r.settings.join(", ")}`);
  if (r.favorites) lines.push(`${plural(r.favorites, "favorite")} added`);
  if (r.history) lines.push(`${plural(r.history, "history event")} added`);
  if (r.archived) lines.push(`${plural(r.archived, "archived skill")} added`);
  if (r.reinstall.length) {
    lines.push(
      commands
        ? `${plural(r.reinstall.length, "installed skill")} to reinstall:`
        : `${plural(r.reinstall.length, "installed skill")} to reinstall from their source`,
    );
    if (commands) for (const i of r.reinstall) lines.push(`  ${i.command}`);
  }
  if (!lines.length)
    lines.push("Nothing to do: this machine already has everything in the backup.");
  return lines;
}
