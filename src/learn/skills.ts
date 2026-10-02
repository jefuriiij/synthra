// The skill writer — Hermes' self-written skills, for Claude Code's own skill
// folders, so a skill Synthra writes is one Claude Code loads by itself
// (hot-reloaded, no restart):
//
//   project  <project>/.claude/skills/<name>/SKILL.md   steps that only make
//            sense in this repo; shared with the team in git
//   global   ~/.claude/skills/<name>/SKILL.md           reusable how-tos for
//            every project; records the project it was learned in
//
// Rules, most of them Hermes':
//   - Who owns a skill decides what Synthra may do with it. A skill Synthra
//     wrote carries `metadata: synthra: learned` in its frontmatter (in the
//     file, so the mark travels with the skill to a teammate's machine), and
//     any change is allowed. The user's own skills may be patched or given
//     support files, but every such change waits for the user's OK, even with
//     approval off, and is written byte for byte, never re-rendered. Skills an
//     installer put there (`npx skills`, listed in .skill-lock.json) are
//     read-only.
//   - A skill is a folder: SKILL.md plus support files under references/,
//     templates/ and scripts/, so one broad skill can grow without one huge
//     SKILL.md. A change to a script always waits for the user's OK.
//   - A skill must be viewed before it is changed (read-before-write), so a
//     change is made against what is really there.
//   - One waiting change per file: a second change to the same file folds into
//     the one that waits, so the user never sees a queue of stale proposals.
//   - With the "New skills wait for my OK" setting on (the default), a new or
//     changed skill is a *proposal* until the user approves it in the Learning
//     tab. Approving re-checks the file is still what the proposal was made
//     against.
//   - Every applied change is recorded — who, what, when, why — with the
//     before/after text, so the Learning tab can show it as a diff.
//
// What Synthra keeps lives in ~/.synthra/skills/ (paths.skillState):
//   pending/<id>.json   proposals waiting for the user
//   ledger.jsonl        one line per change
//   blobs/<sha1>.md     before/after texts, by content hash

import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { readFrontmatter, readSkillLock } from "../dashboard/arsenal.js";
import { INVISIBLE, SECRETS } from "../memory/knowledge.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { type SynthraPaths, pathKey } from "../shared/paths.js";

export type SkillScope = "project" | "global";

/** The frontmatter a Synthra skill has, and all it may have. */
const FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "metadata.synthra",
  "metadata.synthra-origin",
]);

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DESCRIPTION_MAX = 1024;
export const BODY_MAX = 20_000;

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  /** Global skills: the project it was learned in. */
  origin?: string;
}

// ─── the file ───────────────────────────────────────────────────────────────

/** A YAML scalar that every reader takes the same way: plain when that is
 *  unambiguous, double-quoted otherwise. */
function yamlString(s: string): string {
  const plain =
    /^[A-Za-z0-9(]/.test(s) && !/[:#]\s|\s#|[\n"'`\\{}[\]|>&*!%@]|:$/.test(s) && s === s.trim();
  return plain ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderSkill(d: SkillDraft): string {
  return [
    "---",
    `name: ${d.name}`,
    `description: ${yamlString(d.description)}`,
    "metadata:",
    "  synthra: learned",
    ...(d.origin ? [`  synthra-origin: ${yamlString(d.origin)}`] : []),
    "---",
    "",
    d.body.replace(/\r\n/g, "\n").trim(),
    "",
  ].join("\n");
}

export interface ParsedSkill {
  name?: string;
  description?: string;
  body: string;
  learned: boolean;
  origin?: string;
}

export function parseSkill(text: string): ParsedSkill {
  const { fm, body } = readFrontmatter(text);
  return {
    ...(fm.name ? { name: fm.name } : {}),
    ...(fm.description ? { description: fm.description.replace(/\\(["\\])/g, "$1") } : {}),
    body,
    learned: fm["metadata.synthra"] === "learned",
    ...(fm["metadata.synthra-origin"] ? { origin: fm["metadata.synthra-origin"] } : {}),
  };
}

/** Why a skill can't be saved as written, or null. */
export function checkDraft(d: SkillDraft): string | null {
  if (!NAME_RE.test(d.name)) {
    return "The name must be lowercase letters, digits and hyphens, at most 64 characters (e.g. `release-checklist`).";
  }
  const desc = d.description.trim();
  if (!desc) return "The description is required: it is how the AI decides when to load the skill.";
  if (/\n/.test(desc)) return "The description must be one line.";
  if (desc.length > DESCRIPTION_MAX) {
    return `The description is ${desc.length} characters; the limit is ${DESCRIPTION_MAX}.`;
  }
  if (!d.body.trim()) return "The skill has no body: write the steps.";
  if (d.body.length > BODY_MAX) {
    return `The body is ${d.body.length} characters; the limit is ${BODY_MAX}. Keep the steps, move detail out.`;
  }
  const all = `${desc}\n${d.body}`;
  if (INVISIBLE.test(all)) return "The skill contains invisible control characters.";
  if (SECRETS.some((re) => re.test(all))) {
    return "The skill looks like it contains a secret (a key, token or password). Never put secrets in a skill.";
  }
  return null;
}

// ─── where things are ───────────────────────────────────────────────────────

export function skillPath(paths: SynthraPaths, scope: SkillScope, name: string): string {
  return join(
    scope === "project" ? paths.projectSkillsDir : paths.globalSkillsDir,
    name,
    "SKILL.md",
  );
}

const readText = (p: string) => readFile(p, "utf8").catch(() => null);

export interface SkillInfo {
  name: string;
  scope: SkillScope;
  path: string;
  description: string;
  learned: boolean;
  origin?: string;
}

async function listDir(dir: string, scope: SkillScope): Promise<SkillInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name, "SKILL.md");
    const text = await readText(path);
    if (text === null) continue;
    const p = parseSkill(text);
    out.push({
      name,
      scope,
      path,
      description: p.description ?? "",
      learned: p.learned,
      ...(p.origin ? { origin: p.origin } : {}),
    });
  }
  return out;
}

/** Every skill in both folders (project first). */
export async function listSkills(paths: SynthraPaths): Promise<SkillInfo[]> {
  return [
    ...(await listDir(paths.projectSkillsDir, "project")),
    ...(await listDir(paths.globalSkillsDir, "global")),
  ];
}

/** A skill folder's name: one plain path segment, so a name can never walk out
 *  of the skills folder ("../x"). */
const SKILL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The skill by name: the given scope, or project before global. The name must
 *  be a folder that is really there, spelled the same: on Windows "Deploy"
 *  would otherwise open "deploy" under a path no pin or usage record knows. */
export async function findSkill(
  paths: SynthraPaths,
  name: string,
  scope?: SkillScope,
): Promise<(SkillInfo & { text: string }) | null> {
  if (!SKILL_DIR_RE.test(name)) return null;
  for (const s of scope ? [scope] : (["project", "global"] as const)) {
    const dir = s === "project" ? paths.projectSkillsDir : paths.globalSkillsDir;
    if (!(await readdir(dir).catch(() => [] as string[])).includes(name)) continue;
    const path = skillPath(paths, s, name);
    const text = await readText(path);
    if (text === null) continue;
    const p = parseSkill(text);
    return {
      name,
      scope: s,
      path,
      text,
      description: p.description ?? "",
      learned: p.learned,
      ...(p.origin ? { origin: p.origin } : {}),
    };
  }
  return null;
}

// ─── who owns a skill ───────────────────────────────────────────────────────

/** synthra: Synthra wrote it. user: the user's own. third_party: an installer
 *  put it there and may overwrite it, so nobody else edits it. */
export type Owner = "synthra" | "user" | "third_party";

export interface Ownership {
  owner: Owner;
  /** third_party: the repo it was installed from. */
  source?: string;
  /** The real folder, when the skill's folder is a link (or a Windows junction). */
  linkedTo?: string;
}

/** The `npx skills` lock file for a scope: <project>/.agents/.skill-lock.json,
 *  or ~/.agents/.skill-lock.json next to ~/.claude for global skills. */
export function skillLockPath(paths: SynthraPaths, scope: SkillScope): string {
  return scope === "project"
    ? join(paths.projectRoot, ".agents", ".skill-lock.json")
    : join(dirname(dirname(paths.globalSkillsDir)), ".agents", ".skill-lock.json");
}

/** Where a skill's folder really is, when it is a link. Node reports a Windows
 *  junction as a symbolic link too. */
async function linkTarget(dir: string): Promise<string | undefined> {
  try {
    if ((await lstat(dir)).isSymbolicLink()) return await realpath(dir);
  } catch {
    // Missing or unreadable: not a link we can follow.
  }
  return undefined;
}

export async function ownership(paths: SynthraPaths, s: SkillInfo): Promise<Ownership> {
  const linkedTo = await linkTarget(dirname(s.path));
  const link = linkedTo ? { linkedTo } : {};
  if (s.learned) return { owner: "synthra", ...link };
  const lock = await readSkillLock(skillLockPath(paths, s.scope));
  const source = lock.get(s.name) ?? (linkedTo ? lock.get(basename(linkedTo)) : undefined);
  return source ? { owner: "third_party", source, ...link } : { owner: "user", ...link };
}

// ─── read-before-write ──────────────────────────────────────────────────────

/** Skill files viewed (or written) in this server process. A change needs the
 *  file in here, so it is made against what is really on disk. */
const viewed = new Set<string>();

export function markViewed(path: string): void {
  viewed.add(pathKey(path));
}

export function wasViewed(path: string): boolean {
  return viewed.has(pathKey(path));
}

export function __resetViewed(): void {
  viewed.clear();
}

// ─── proposals, the ledger, blobs ───────────────────────────────────────────

/** create: a new file. patch/edit: a changed file. remove: a support file deleted. */
export type SkillAction = "create" | "patch" | "edit" | "remove";

export interface Proposal {
  id: string;
  ts: string;
  /** "archive" moves the skill out of use (the Curator, or a merge). */
  action: SkillAction | "archive";
  scope: SkillScope;
  name: string;
  /** The file the proposal writes: SKILL.md, or a support file. */
  path: string;
  /** A support file, relative to the skill's folder ("references/maps.md").
   *  Absent: the proposal is about SKILL.md. */
  file?: string;
  /** "user": a change to the user's own skill, not one Synthra wrote. */
  owner?: "user";
  /** The skill's folder is a link to this folder: the change is saved there. */
  linkedTo?: string;
  /** The project it was made in. */
  project: string;
  /** The file as the proposal was made against it; null for a new file. */
  before: string | null;
  after: string;
  /** What the AI said the change is for. */
  reason?: string;
  /** archive: the folder the skill moves to. */
  archiveTo?: string;
  /** archive for a merge: the skill this one was merged into, and its SKILL.md. */
  absorbedInto?: string;
  absorbedPath?: string;
}

export interface SkillEvent {
  id: string;
  ts: string;
  action: SkillAction | "reject" | "archive" | "restore";
  /** Who made the change. An approved proposal is still its author's. */
  actor: "agent" | "user" | "curator";
  /** Set when the user approved it (approval on). */
  approved?: boolean;
  scope: SkillScope;
  name: string;
  path: string;
  /** A support file, relative to the skill's folder. */
  file?: string;
  /** "user": the user's own skill. */
  owner?: "user";
  project: string;
  beforeSha?: string;
  afterSha?: string;
  reason?: string;
  /** archive/restore: where the archived copy is. */
  archivePath?: string;
  /** archive for a merge: the skill this one was merged into. */
  absorbedInto?: string;
  /** reject: what the rejected proposal would have done. Rejecting an
   *  archive means "keep it", which the Curator counts as activity. */
  rejected?: SkillAction | "archive";
}

/** The SKILL.md a proposal or event belongs to: its own path, or for a
 *  support file the SKILL.md as many folders up as the file is deep. */
export function skillMdOf(x: { path: string; file?: string }): string {
  if (!x.file) return x.path;
  let dir = x.path;
  for (const _ of x.file.split("/")) dir = dirname(dir);
  return join(dir, "SKILL.md");
}

const sha = (text: string) => createHash("sha1").update(text).digest("hex");

async function saveBlob(state: string, text: string): Promise<string> {
  const h = sha(text);
  const p = join(state, "blobs", `${h}.md`);
  try {
    await stat(p);
  } catch {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, "utf8");
  }
  return h;
}

/** A stored before/after text, or null when it was never kept (or pruned). */
export async function readBlob(state: string, h: string): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(h)) return null;
  return readText(join(state, "blobs", `${h}.md`));
}

async function record(state: string, e: SkillEvent): Promise<void> {
  await mkdir(state, { recursive: true });
  await appendFile(join(state, "ledger.jsonl"), `${JSON.stringify(e)}\n`, "utf8");
}

export async function readLedger(state: string): Promise<SkillEvent[]> {
  const text = await readText(join(state, "ledger.jsonl"));
  if (!text) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as SkillEvent];
      } catch {
        return [];
      }
    });
}

const pendingDir = (state: string) => join(state, "pending");

export async function listPending(state: string): Promise<Proposal[]> {
  let files: string[];
  try {
    files = await readdir(pendingDir(state));
  } catch {
    return [];
  }
  const out: Proposal[] = [];
  for (const f of files.filter((x) => x.endsWith(".json")).sort()) {
    try {
      out.push(JSON.parse((await readText(join(pendingDir(state), f))) ?? "") as Proposal);
    } catch {
      // A torn proposal is skipped, never applied.
    }
  }
  // Oldest first; two made in the same millisecond keep a fixed order by id.
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
}

async function writeSkillFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/**
 * Move a folder. rename() first. Only when that can't cross a filesystem
 * boundary (EXDEV — ~/.claude on its own volume, a project on another disk)
 * does it copy instead:
 *   - a copy that fails is removed again, and the original is untouched;
 *   - the original is removed only once the copy is complete (its SKILL.md is
 *     there); if removing it fails after that, the move still counts as done,
 *     so the caller records the archive and the skill stays restorable —
 *     better a leftover folder than a skill in neither place.
 * A locked file (EPERM/EBUSY on Windows) is not a reason to copy: deleting
 * the original would stop halfway on that same lock. It fails cleanly, as a
 * rename does, and the next pass tries again.
 */
export async function moveDir(
  from: string,
  to: string,
  /** Tests pass a rename that fails, to reach the copy path on one disk. */
  tryRename: (a: string, b: string) => Promise<void> = rename,
): Promise<void> {
  // A link (or a Windows junction) moves as a link: rename moves the link
  // itself. Never copy-then-delete through one, which would empty the folder it
  // points at (a skills repo shared with other tools).
  const isLink = await lstat(from).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  try {
    await tryRename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  if (isLink) {
    await symlink(await readlink(from), to, process.platform === "win32" ? "junction" : "dir");
    await rm(from, { force: true });
    return;
  }
  try {
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await stat(join(to, "SKILL.md"));
  } catch (err) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await rm(from, { recursive: true, force: true }).catch((err) =>
    log.warn(`moved ${from} by copy, but couldn't remove the original: ${(err as Error).message}`),
  );
}

/** A folder name that isn't taken: `name`, else `name-2`, `name-3`, … */
async function freeDir(dir: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? dir : `${dir}-${n}`;
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
}

/** Move a skill's folder into the archive and record it. */
/** Move a skill's folder into the archive and record it. The Curator's
 *  archives say "curator", a merge's say "agent", a delete in the IDE "user". */
async function archive(
  state: string,
  p: Proposal,
  approved: boolean,
  actor: SkillEvent["actor"] = p.absorbedInto ? "agent" : "curator",
): Promise<SkillEvent> {
  const to = await freeDir(p.archiveTo ?? join(state, "archive", p.name));
  await mkdir(dirname(to), { recursive: true });
  await moveDir(dirname(p.path), to);
  const e: SkillEvent = {
    id: p.id,
    ts: new Date().toISOString(),
    action: "archive",
    actor,
    ...(approved ? { approved: true } : {}),
    scope: p.scope,
    name: p.name,
    path: p.path,
    ...(p.owner ? { owner: p.owner } : {}),
    project: p.project,
    ...(p.before !== null ? { beforeSha: await saveBlob(state, p.before) } : {}),
    ...(p.reason ? { reason: p.reason } : {}),
    archivePath: to,
    ...(p.absorbedInto ? { absorbedInto: p.absorbedInto } : {}),
  };
  await record(state, e);
  return e;
}

/** The user deleted a skill in the IDE: it moves into the archive at once
 *  (they confirmed it there), so Restore in the Learning tab brings it back. */
export async function archiveSkill(
  paths: SynthraPaths,
  s: SkillInfo,
  { reason }: { reason: string },
): Promise<Answer> {
  const before = await readText(s.path);
  if (before === null) return { ok: false, error: `"${s.name}" isn't there any more.` };
  const own = await ownership(paths, s);
  try {
    const event = await archive(
      paths.skillState,
      {
        id: newId(),
        ts: new Date().toISOString(),
        action: "archive",
        scope: s.scope,
        name: s.name,
        path: s.path,
        ...ownerFields(own),
        project: paths.projectRoot,
        before,
        after: "",
        reason,
        archiveTo: archiveDirFor(paths, s.scope, s.name),
      },
      false,
      "user",
    );
    return { ok: true, event };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't move "${s.name}" to the archive: ${(err as Error).message}. Close any file of it that is open, then try again.`,
    };
  }
}

async function apply(state: string, p: Proposal, approved: boolean): Promise<SkillEvent> {
  if (p.action === "archive") return archive(state, p, approved);
  if (p.action === "remove") await rm(p.path, { force: true });
  else {
    await writeSkillFile(p.path, p.after);
    markViewed(p.path);
  }
  const e: SkillEvent = {
    id: p.id,
    ts: new Date().toISOString(),
    action: p.action,
    actor: "agent",
    ...(approved ? { approved: true } : {}),
    scope: p.scope,
    name: p.name,
    path: p.path,
    ...(p.file ? { file: p.file } : {}),
    ...(p.owner ? { owner: p.owner } : {}),
    project: p.project,
    ...(p.before !== null ? { beforeSha: await saveBlob(state, p.before) } : {}),
    ...(p.action !== "remove" ? { afterSha: await saveBlob(state, p.after) } : {}),
    ...(p.reason ? { reason: p.reason } : {}),
  };
  await record(state, e);
  return e;
}

// ─── the operations the tool exposes ────────────────────────────────────────

export type Outcome =
  | { status: "applied"; path: string; event: SkillEvent }
  | { status: "pending"; proposal: Proposal; always: boolean }
  /** The change undid the one that waited for the same file: nothing waits now. */
  | { status: "dropped"; name: string; path: string }
  | { status: "error"; error: string };

export function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** The change that waits for this file, if one does (archives aside). */
export async function waitingFor(state: string, path: string): Promise<Proposal | undefined> {
  const key = pathKey(path);
  return (await listPending(state)).find((p) => p.action !== "archive" && pathKey(p.path) === key);
}

/** What a change to a file builds on. With a change already waiting for that
 *  file, the new one folds into it: it builds on the waiting text and keeps the
 *  waiting change's `before`, so approving it applies both. */
async function baseFor(
  paths: SynthraPaths,
  path: string,
  disk: string | null,
): Promise<
  { before: string | null; base: string | null; replaces?: Proposal } | { error: string }
> {
  const w = await waitingFor(paths.skillState, path);
  if (!w) return { before: disk, base: disk };
  if (disk !== w.before) {
    return {
      error: `A change to "${w.name}" waits for the user's OK, but the file changed since. Ask the user to reject that change first.`,
    };
  }
  return { before: w.before, base: w.action === "remove" ? null : w.after, replaces: w };
}

export interface SubmitOptions {
  /** Wait for the user's OK even when approval is off: the user's own skills,
   *  and scripts. */
  mustWait?: boolean;
  /** The waiting proposal this one folds into (it is removed). */
  replaces?: Proposal;
}

/** Apply now, or park as a proposal, per the "New skills wait for my OK" setting. */
export async function submit(
  paths: SynthraPaths,
  p: Proposal,
  { mustWait = false, replaces }: SubmitOptions = {},
): Promise<Outcome> {
  const state = paths.skillState;
  const dropOld = async () => {
    if (replaces) await rm(join(pendingDir(state), `${replaces.id}.json`), { force: true });
  };
  if (replaces) {
    const reasons = [replaces.reason, p.reason].filter(Boolean);
    p = { ...p, ...(reasons.length ? { reason: reasons.join("; ") } : {}) };
    if (p.before !== null && p.action !== "remove" && p.after === p.before) {
      await dropOld();
      return { status: "dropped", name: p.name, path: p.path };
    }
  }
  const always = mustWait && !loadConfig().skillApproval;
  if (loadConfig().skillApproval || mustWait) {
    await mkdir(pendingDir(state), { recursive: true });
    await writeFile(join(pendingDir(state), `${p.id}.json`), JSON.stringify(p, null, 2), "utf8");
    await dropOld();
    return { status: "pending", proposal: p, always };
  }
  const event = await apply(state, p, false);
  await dropOld();
  return { status: "applied", path: p.path, event };
}

export interface CreateInput {
  scope: SkillScope;
  name: string;
  description: string;
  body: string;
  reason?: string;
}

export async function createSkill(paths: SynthraPaths, input: CreateInput): Promise<Outcome> {
  const draft: SkillDraft = {
    name: input.name,
    description: input.description.trim(),
    body: input.body,
    ...(input.scope === "global" ? { origin: basename(paths.projectRoot) } : {}),
  };
  const bad = checkDraft(draft);
  if (bad) return { status: "error", error: bad };
  const path = skillPath(paths, input.scope, input.name);
  if ((await readText(path)) !== null) {
    return {
      status: "error",
      error: `A skill named "${input.name}" already exists here (${input.scope}). View it, then patch it if Synthra wrote it — or pick another name.`,
    };
  }
  const waiting = (await listPending(paths.skillState)).find(
    (x) => x.path === path && x.action === "create",
  );
  if (waiting) {
    return {
      status: "error",
      error: `A new skill named "${input.name}" is already waiting for the user's OK. Don't propose it twice.`,
    };
  }
  return submit(paths, {
    id: newId(),
    ts: new Date().toISOString(),
    action: "create",
    scope: input.scope,
    name: input.name,
    path,
    project: paths.projectRoot,
    before: null,
    after: renderSkill(draft),
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

/** What a change is: to SKILL.md in part (patch) or whole (edit), or to a
 *  support file. */
type ChangeKind = "patch" | "edit" | "file";

/** The skill to change, if Synthra may change it this way. */
async function changeable(
  paths: SynthraPaths,
  name: string,
  scope: SkillScope | undefined,
  kind: ChangeKind,
): Promise<{ ok: SkillInfo & { text: string }; own: Ownership } | { error: string }> {
  const s = await findSkill(paths, name, scope);
  if (!s) return { error: `No skill named "${name}"${scope ? ` in ${scope}` : ""}.` };
  const own = await ownership(paths, s);
  if (own.owner === "third_party") {
    return {
      error: `"${name}" was installed from ${own.source} (npx skills), so Synthra won't change it: the installer would overwrite it. Suggest the change to the user instead.`,
    };
  }
  if (own.owner === "user" && kind === "edit") {
    return {
      error: `"${name}" is the user's own skill, so a full rewrite isn't allowed. Change it with patch (one exact piece), or add a support file with write_file.`,
    };
  }
  if (!wasViewed(s.path)) {
    return {
      error: `View "${name}" first (action "view"), then change it, so the change is made against what is really there.`,
    };
  }
  return { ok: s, own };
}

/** One exact, unique piece of `text` replaced. A file with CRLF line ends is
 *  matched with the AI's plain "\n" too, and keeps its CRLF. */
function replaceOnce(
  text: string,
  oldS: string,
  newS: string,
): { text: string } | { error: string } {
  if (!oldS) return { error: "old_string is empty." };
  let o = oldS;
  let n = newS;
  if (!text.includes(o) && text.includes("\r\n") && o.includes("\n") && !o.includes("\r")) {
    o = o.replace(/\n/g, "\r\n");
    n = n.replace(/\r?\n/g, "\r\n");
  }
  const hits = text.split(o).length - 1;
  if (hits === 0) {
    return { error: "old_string isn't in the file. View it again and copy the exact text." };
  }
  if (hits > 1) {
    return {
      error: `old_string appears ${hits} times; include more of the surrounding text so it is unique.`,
    };
  }
  return { text: text.replace(o, () => n) };
}

/** The raw frontmatter block, or null when the file has none. */
function frontmatterBlock(text: string): string | null {
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? (m[1] ?? "") : null;
}

/** The frontmatter block without its `description` (and the lines it runs on). */
function withoutDescription(block: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^description:/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^[ \t]/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out.join("\n");
}

/** Why a patch to the user's own skill is not allowed, or null. Only the body
 *  and the description may change: a new `allowed-tools`, `model` or `hooks`
 *  line changes what the skill may do, and hides in a diff as one line. */
function checkUserPatch(before: string, after: string, added: string): string | null {
  const fb = frontmatterBlock(before);
  const fa = frontmatterBlock(after);
  if (fb !== null && fa === null)
    return "The patch breaks the skill's frontmatter (its --- lines).";
  if (fb === null && fa !== null) return "A patch to the user's skill can't add frontmatter.";
  if (fb !== null && fa !== null && withoutDescription(fb) !== withoutDescription(fa)) {
    return "A patch to the user's skill may change its body or its description only, not its other frontmatter (name, allowed-tools and the like).";
  }
  const desc = parseSkill(after).description?.trim() ?? "";
  if (fb !== null && !desc)
    return "The description is required: it is how the AI decides when to load the skill.";
  if (/\n/.test(desc)) return "The description must be one line.";
  if (desc.length > DESCRIPTION_MAX) {
    return `The description is ${desc.length} characters; the limit is ${DESCRIPTION_MAX}.`;
  }
  const limit = Math.max(BODY_MAX, before.length);
  if (after.length > limit) {
    return `The skill would be ${after.length} characters; keep it under ${limit}. Move detail into a support file (write_file, references/<topic>.md).`;
  }
  if (INVISIBLE.test(added)) return "The new text contains invisible control characters.";
  if (SECRETS.some((re) => re.test(added))) {
    return "The new text looks like it contains a secret (a key, token or password). Never put secrets in a skill.";
  }
  return null;
}

const ownerFields = (own: Ownership): Pick<Proposal, "owner" | "linkedTo"> => ({
  ...(own.owner === "user" ? { owner: "user" as const } : {}),
  ...(own.linkedTo ? { linkedTo: own.linkedTo } : {}),
});

export interface PatchInput {
  scope?: SkillScope;
  name: string;
  /** A support file instead of SKILL.md ("references/maps.md"). */
  file_path?: string;
  old_string: string;
  new_string: string;
  reason?: string;
}

/** A targeted fix: one exact piece of SKILL.md (or of a support file) replaced. */
export async function patchSkill(paths: SynthraPaths, input: PatchInput): Promise<Outcome> {
  if (input.file_path) return patchSupportFile(paths, input);
  const c = await changeable(paths, input.name, input.scope, "patch");
  if ("error" in c) return { status: "error", error: c.error };
  const s = c.ok;
  const b = await baseFor(paths, s.path, s.text);
  if ("error" in b) return { status: "error", error: b.error };
  const base = b.base ?? s.text;
  const before = b.before ?? s.text;
  const r = replaceOnce(base, input.old_string, input.new_string);
  if ("error" in r) return { status: "error", error: r.error };
  const proposal = (after: string): Proposal => ({
    id: newId(),
    ts: new Date().toISOString(),
    action: "patch",
    scope: s.scope,
    name: s.name,
    path: s.path,
    ...ownerFields(c.own),
    project: paths.projectRoot,
    before,
    after,
    ...(input.reason ? { reason: input.reason } : {}),
  });

  if (c.own.owner === "user") {
    // The user's file, byte for byte: never re-rendered, never marked.
    const bad = checkUserPatch(before, r.text, input.new_string);
    if (bad) return { status: "error", error: bad };
    return submit(paths, proposal(r.text), {
      mustWait: true,
      ...(b.replaces ? { replaces: b.replaces } : {}),
    });
  }

  const patched = r.text;
  const p = parseSkill(patched);
  if (!p.learned || p.name !== s.name) {
    return {
      status: "error",
      error:
        "The patch would change the skill's name or remove Synthra's mark. Change the body or the description only.",
    };
  }
  // Only Synthra's own frontmatter keys. Anything else (allowed-tools, hooks,
  // model) changes what the skill may do, and would hide in a diff as one line.
  const extra = Object.keys(readFrontmatter(patched).fm).filter((k) => !FRONTMATTER_KEYS.has(k));
  if (extra.length) {
    return {
      status: "error",
      error: `A patch can't add frontmatter (${extra.join(", ")}). Change the body or the description only.`,
    };
  }
  const draft: SkillDraft = {
    name: s.name,
    description: (p.description ?? "").trim(),
    body: p.body,
    ...(p.origin ? { origin: p.origin } : {}),
  };
  const bad = checkDraft(draft);
  if (bad) return { status: "error", error: bad };
  // Re-rendered, so the frontmatter is always Synthra's canonical form.
  return submit(paths, proposal(renderSkill(draft)), b.replaces ? { replaces: b.replaces } : {});
}

export interface EditInput {
  scope?: SkillScope;
  name: string;
  description?: string;
  body?: string;
  reason?: string;
}

/** A rewrite of a skill Synthra wrote: new description and/or body; the name
 *  and the mark stay. */
export async function editSkill(paths: SynthraPaths, input: EditInput): Promise<Outcome> {
  const c = await changeable(paths, input.name, input.scope, "edit");
  if ("error" in c) return { status: "error", error: c.error };
  const s = c.ok;
  if (input.description === undefined && input.body === undefined) {
    return { status: "error", error: "Give a new description, a new body, or both." };
  }
  const b = await baseFor(paths, s.path, s.text);
  if ("error" in b) return { status: "error", error: b.error };
  const old = parseSkill(b.base ?? s.text);
  const draft: SkillDraft = {
    name: s.name,
    description: (input.description ?? old.description ?? "").trim(),
    body: input.body ?? old.body,
    ...(old.origin ? { origin: old.origin } : {}),
  };
  const bad = checkDraft(draft);
  if (bad) return { status: "error", error: bad };
  return submit(
    paths,
    {
      id: newId(),
      ts: new Date().toISOString(),
      action: "edit",
      scope: s.scope,
      name: s.name,
      path: s.path,
      ...ownerFields(c.own),
      project: paths.projectRoot,
      before: b.before ?? s.text,
      after: renderSkill(draft),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    b.replaces ? { replaces: b.replaces } : {},
  );
}

// ─── support files: references/, templates/, scripts/ ───────────────────────

/** The folders a support file may live in. Text only: no assets/ yet. */
export const SUPPORT_DIRS = ["references", "templates", "scripts"] as const;
/** Characters in one support file. */
export const SUPPORT_MAX = 40_000;
/** Support files in one skill. */
export const SUPPORT_FILES_MAX = 30;

const SUPPORT_EXT = /\.(md|txt|json|ya?ml|csv|html|css|js|mjs|cjs|ts|py|sh|ps1)$/i;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** Why a support-file path is not allowed, or null. A read may name any file
 *  in the skill's folder; a write must go under references/, templates/ or
 *  scripts/ and be a text file. */
export function checkSupportPath(rel: string, forRead = false): string | null {
  const example = "e.g. references/forms.md";
  if (!rel) return `file_path is required (${example}).`;
  if (rel.length > 200) return "file_path is too long.";
  if (/[\\:]/.test(rel) || rel.startsWith("/")) {
    return `file_path is relative to the skill's folder and uses / (${example}).`;
  }
  const segs = rel.split("/");
  if (segs.length > 4) return "file_path is too deep: at most three folders.";
  for (const seg of segs) {
    if (!SEGMENT_RE.test(seg) || seg.endsWith(".") || RESERVED_RE.test(seg)) {
      return `"${seg}" isn't an allowed name in file_path: use letters, digits, ".", "_" and "-".`;
    }
  }
  if (segs.some((seg) => seg.toLowerCase() === "skill.md")) {
    return "SKILL.md is changed with patch or edit, not as a support file.";
  }
  if (forRead) return null;
  if (segs.length < 2 || !(SUPPORT_DIRS as readonly string[]).includes(segs[0] ?? "")) {
    return `file_path must start with references/, templates/ or scripts/ (${example}).`;
  }
  if (!SUPPORT_EXT.test(rel)) {
    return "Support files are text: .md, .txt, .json, .yaml, .csv, .html, .css, .js, .ts, .py, .sh or .ps1.";
  }
  return null;
}

/** Why a support file's text can't be saved, or null. */
export function checkSupportText(text: string, limit = SUPPORT_MAX): string | null {
  if (text.includes("\u0000")) return "The file contains a NUL character: support files are text.";
  if (text.length > limit) {
    return `The file is ${text.length} characters; the limit is ${limit}. Split it by topic.`;
  }
  if (INVISIBLE.test(text)) return "The file contains invisible control characters.";
  if (SECRETS.some((re) => re.test(text))) {
    return "The file looks like it contains a secret (a key, token or password). Never put secrets in a skill.";
  }
  return null;
}

/** The support file's absolute path, if it stays inside the skill's folder.
 *  Checked through real paths, so a link inside the skill can't lead out. */
async function resolveSupport(
  skillDir: string,
  rel: string,
): Promise<{ abs: string } | { error: string }> {
  const abs = join(skillDir, ...rel.split("/"));
  let real: string;
  try {
    real = pathKey(await realpath(skillDir));
  } catch {
    return { error: "The skill's folder isn't there." };
  }
  const leaves = { error: "That path leaves the skill's folder." };
  // The deepest part of the path that exists must still be inside the folder.
  for (let cur = abs; ; ) {
    try {
      const r = pathKey(await realpath(cur));
      if (r !== real && !r.startsWith(real + sep)) return leaves;
      break;
    } catch {
      const up = dirname(cur);
      if (up === cur) return leaves;
      cur = up;
    }
  }
  try {
    if (!(await lstat(abs)).isFile()) return { error: `${rel} isn't a plain file.` };
  } catch {
    // Not there yet: fine for a new file.
  }
  return { abs };
}

/** The files beside a skill's SKILL.md, relative to its folder, sorted. A
 *  bounded walk that never follows a link out of the folder. */
export async function listSupportFiles(
  dir: string,
  max = 50,
): Promise<{ files: string[]; more: number }> {
  const files: string[] = [];
  let visited = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(rel ? join(dir, ...rel.split("/")) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++visited > 500) return;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name.endsWith(".tmp")) continue;
      if (!rel && e.name === "SKILL.md") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 3) await walk(r, depth + 1);
      } else if (e.isFile()) files.push(r);
    }
  };
  await walk("", 0);
  files.sort();
  return { files: files.slice(0, max), more: Math.max(0, files.length - max) };
}

export interface FileInput {
  scope?: SkillScope;
  name: string;
  file_path: string;
  reason?: string;
}

interface SupportTarget {
  s: SkillInfo & { text: string };
  own: Ownership;
  abs: string;
  disk: string | null;
}

/** The support file a write, patch or removal is for, if it may be changed. */
async function supportTarget(
  paths: SynthraPaths,
  input: FileInput,
): Promise<SupportTarget | { error: string }> {
  const bad = checkSupportPath(input.file_path);
  if (bad) return { error: bad };
  const c = await changeable(paths, input.name, input.scope, "file");
  if ("error" in c) return c;
  const r = await resolveSupport(dirname(c.ok.path), input.file_path);
  if ("error" in r) return r;
  const disk = await readText(r.abs);
  if (disk !== null && !wasViewed(r.abs)) {
    return {
      error: `View ${input.file_path} in "${input.name}" first (action "view" with file_path), then change it.`,
    };
  }
  return { s: c.ok, own: c.own, abs: r.abs, disk };
}

function fileProposal(
  paths: SynthraPaths,
  t: SupportTarget,
  input: FileInput,
  action: SkillAction,
  before: string | null,
  after: string,
): Proposal {
  return {
    id: newId(),
    ts: new Date().toISOString(),
    action,
    scope: t.s.scope,
    name: t.s.name,
    path: t.abs,
    file: input.file_path,
    ...ownerFields(t.own),
    project: paths.projectRoot,
    before,
    after,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/** Scripts run code, and the user's own skills are the user's: both wait. */
const mustWaitFor = (t: SupportTarget, file: string) =>
  t.own.owner === "user" || file.startsWith("scripts/");

/** A new support file, or a whole new text for one. */
export async function writeSupportFile(
  paths: SynthraPaths,
  input: FileInput & { content: string },
): Promise<Outcome> {
  const t = await supportTarget(paths, input);
  if ("error" in t) return { status: "error", error: t.error };
  const bad = checkSupportText(input.content);
  if (bad) return { status: "error", error: bad };
  if (t.disk === null) {
    const { files, more } = await listSupportFiles(dirname(t.s.path), SUPPORT_FILES_MAX);
    if (files.length + more >= SUPPORT_FILES_MAX) {
      return {
        status: "error",
        error: `"${t.s.name}" already has ${SUPPORT_FILES_MAX} support files; extend one of them instead.`,
      };
    }
  }
  const b = await baseFor(paths, t.abs, t.disk);
  if ("error" in b) return { status: "error", error: b.error };
  const action: SkillAction = b.before === null ? "create" : "edit";
  return submit(paths, fileProposal(paths, t, input, action, b.before, input.content), {
    mustWait: mustWaitFor(t, input.file_path),
    ...(b.replaces ? { replaces: b.replaces } : {}),
  });
}

/** One exact piece of a support file replaced. */
async function patchSupportFile(paths: SynthraPaths, input: PatchInput): Promise<Outcome> {
  const file = input.file_path ?? "";
  const t = await supportTarget(paths, { ...input, file_path: file });
  if ("error" in t) return { status: "error", error: t.error };
  const b = await baseFor(paths, t.abs, t.disk);
  if ("error" in b) return { status: "error", error: b.error };
  if (b.base === null) {
    return {
      status: "error",
      error: `${file} isn't in "${t.s.name}" yet: add it with write_file.`,
    };
  }
  const r = replaceOnce(b.base, input.old_string, input.new_string);
  if ("error" in r) return { status: "error", error: r.error };
  // The new text is checked for secrets, not the whole file: an example token
  // already in it would otherwise block every fix.
  const limit = Math.max(SUPPORT_MAX, (b.before ?? "").length);
  const bad =
    checkSupportText(input.new_string, Number.POSITIVE_INFINITY) ??
    (r.text.length > limit
      ? `The file would be ${r.text.length} characters; the limit is ${limit}. Split it by topic.`
      : null);
  if (bad) return { status: "error", error: bad };
  return submit(
    paths,
    fileProposal(paths, t, { ...input, file_path: file }, "patch", b.before, r.text),
    {
      mustWait: mustWaitFor(t, file),
      ...(b.replaces ? { replaces: b.replaces } : {}),
    },
  );
}

/** A support file removed. */
export async function removeSupportFile(paths: SynthraPaths, input: FileInput): Promise<Outcome> {
  const t = await supportTarget(paths, input);
  if ("error" in t) return { status: "error", error: t.error };
  if (t.disk === null) {
    // Not on disk: only a waiting new file can be "removed", by dropping it.
    const w = await waitingFor(paths.skillState, t.abs);
    if (w?.action === "create") {
      await rm(join(pendingDir(paths.skillState), `${w.id}.json`), { force: true });
      return { status: "dropped", name: t.s.name, path: t.abs };
    }
    return { status: "error", error: `${input.file_path} isn't in "${t.s.name}".` };
  }
  const b = await baseFor(paths, t.abs, t.disk);
  if ("error" in b) return { status: "error", error: b.error };
  return submit(paths, fileProposal(paths, t, input, "remove", b.before, ""), {
    mustWait: mustWaitFor(t, input.file_path),
    ...(b.replaces ? { replaces: b.replaces } : {}),
  });
}

/** A support file's text for `view`: with a change waiting, the waiting text. */
export async function viewSupportFile(
  paths: SynthraPaths,
  name: string,
  scope: SkillScope | undefined,
  rel: string,
): Promise<{ path: string; text: string; waiting: boolean } | { error: string }> {
  const bad = checkSupportPath(rel, true);
  if (bad) return { error: bad };
  const s = await findSkill(paths, name, scope);
  if (!s) return { error: `No skill named "${name}"${scope ? ` in ${scope}` : ""}.` };
  const r = await resolveSupport(dirname(s.path), rel);
  if ("error" in r) return r;
  const [disk, w] = await Promise.all([readText(r.abs), waitingFor(paths.skillState, r.abs)]);
  if (disk === null && !w) {
    const { files } = await listSupportFiles(dirname(s.path));
    return {
      error: `${rel} isn't in "${name}". ${files.length ? `Its files: ${files.join(", ")}.` : "It has no support files."}`,
    };
  }
  markViewed(r.abs);
  const text = w ? (w.action === "remove" ? "" : w.after) : (disk ?? "");
  return { path: r.abs, text, waiting: Boolean(w) };
}

// ─── the user's answer ──────────────────────────────────────────────────────

export type Answer = { ok: true; event: SkillEvent } | { ok: false; error: string };

async function takePending(state: string, id: string): Promise<Proposal | null> {
  if (!/^[a-z0-9]+-[0-9a-f]{6}$/.test(id)) return null;
  const file = join(pendingDir(state), `${id}.json`);
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Proposal;
  } catch {
    return null;
  }
}

/** Approve a proposal: apply it, if the file is still what it was made against. */
export async function approveProposal(state: string, id: string): Promise<Answer> {
  const p = await takePending(state, id);
  if (!p) return { ok: false, error: "That proposal is not waiting any more." };
  // A support file never brings back a skill that was deleted meanwhile.
  if (p.file && (await readText(skillMdOf(p))) === null) {
    return {
      ok: false,
      error: `"${p.name}" isn't there any more, so this file can't be added to it. Reject it.`,
    };
  }
  const now = await readText(p.path);
  if (now !== p.before) {
    return {
      ok: false,
      error:
        p.before === null
          ? p.file
            ? `${p.file} appeared in "${p.name}" since this was proposed. Reject this one.`
            : `A skill named "${p.name}" appeared since this was proposed. Reject this one.`
          : `${p.file ? `${p.file} in "${p.name}"` : `"${p.name}"`} changed since this was proposed, so it can't be applied safely. Reject it, and ask the AI again.`,
    };
  }
  const event = await apply(state, p, true);
  await rm(join(pendingDir(state), `${p.id}.json`), { force: true });
  return { ok: true, event };
}

export async function rejectProposal(state: string, id: string): Promise<Answer> {
  const p = await takePending(state, id);
  if (!p) return { ok: false, error: "That proposal is not waiting any more." };
  await rm(join(pendingDir(state), `${p.id}.json`), { force: true });
  const event: SkillEvent = {
    id: p.id,
    ts: new Date().toISOString(),
    action: "reject",
    actor: "user",
    rejected: p.action,
    scope: p.scope,
    name: p.name,
    path: p.path,
    project: p.project,
    ...(p.reason ? { reason: p.reason } : {}),
  };
  await record(state, event);
  return { ok: true, event };
}

// ─── archive and restore (the Curator) ──────────────────────────────────────

/** Where an archived skill goes: inside the project for a project skill (the
 *  team keeps it in git), under ~/.synthra/skills/archive for a global one. */
export function archiveDirFor(paths: SynthraPaths, scope: SkillScope, name: string): string {
  return scope === "project"
    ? join(paths.contextDir, "skills-archive", name)
    : join(paths.skillState, "archive", name);
}

export interface ArchivedSkill {
  name: string;
  scope: SkillScope;
  /** Where it lived, and goes back to on restore. */
  path: string;
  archivePath: string;
  archivedAt: string;
  project: string;
}

/** Archived skills whose copy is still there and that weren't restored since. */
export async function listArchived(state: string): Promise<ArchivedSkill[]> {
  const latest = new Map<string, SkillEvent>();
  for (const e of await readLedger(state)) {
    if ((e.action === "archive" || e.action === "restore") && e.archivePath)
      latest.set(e.archivePath, e);
  }
  const out: ArchivedSkill[] = [];
  for (const e of latest.values()) {
    if (e.action !== "archive" || !e.archivePath) continue;
    if ((await readText(join(e.archivePath, "SKILL.md"))) === null) continue;
    out.push({
      name: e.name,
      scope: e.scope,
      path: e.path,
      archivePath: e.archivePath,
      archivedAt: e.ts,
      project: e.project,
    });
  }
  return out.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1));
}

/** Put an archived skill back where it was. Refused when something took its place. */
export async function restoreSkill(state: string, archivePath: string): Promise<Answer> {
  const a = (await listArchived(state)).find((x) => x.archivePath === archivePath);
  if (!a) return { ok: false, error: "That skill isn't in the archive any more." };
  if ((await readText(a.path)) !== null) {
    return {
      ok: false,
      error: `A skill named "${a.name}" is back in its place already; rename one of them first.`,
    };
  }
  await mkdir(dirname(dirname(a.path)), { recursive: true });
  await moveDir(a.archivePath, dirname(a.path));
  markViewed(a.path);
  const event: SkillEvent = {
    id: newId(),
    ts: new Date().toISOString(),
    action: "restore",
    actor: "user",
    scope: a.scope,
    name: a.name,
    path: a.path,
    project: a.project,
    archivePath: a.archivePath,
  };
  await record(state, event);
  return { ok: true, event };
}
