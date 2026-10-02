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
//   - Synthra changes only skills it wrote. Each carries `metadata: synthra:
//     learned` in its frontmatter — in the file, so the mark travels with the
//     skill to a teammate's machine.
//   - A skill must be viewed before it is changed (read-before-write), so a
//     change is made against what is really there.
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
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { readFrontmatter } from "../dashboard/arsenal.js";
import { INVISIBLE, SECRETS } from "../memory/knowledge.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";

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

/** The skill by name: the given scope, or project before global. */
export async function findSkill(
  paths: SynthraPaths,
  name: string,
  scope?: SkillScope,
): Promise<(SkillInfo & { text: string }) | null> {
  for (const s of scope ? [scope] : (["project", "global"] as const)) {
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

// ─── read-before-write ──────────────────────────────────────────────────────

/** Skill files viewed (or written) in this server process. A change needs the
 *  file in here, so it is made against what is really on disk. */
const viewed = new Set<string>();

export function markViewed(path: string): void {
  viewed.add(path);
}

export function wasViewed(path: string): boolean {
  return viewed.has(path);
}

export function __resetViewed(): void {
  viewed.clear();
}

// ─── proposals, the ledger, blobs ───────────────────────────────────────────

export type SkillAction = "create" | "patch" | "edit";

export interface Proposal {
  id: string;
  ts: string;
  /** "archive" comes from the Curator: move the skill out of use. */
  action: SkillAction | "archive";
  scope: SkillScope;
  name: string;
  path: string;
  /** The project it was made in. */
  project: string;
  /** The file as the proposal was made against it; null for a new skill. */
  before: string | null;
  after: string;
  /** What the AI said the change is for. */
  reason?: string;
  /** archive: the folder the skill moves to. */
  archiveTo?: string;
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
  project: string;
  beforeSha?: string;
  afterSha?: string;
  reason?: string;
  /** archive/restore: where the archived copy is. */
  archivePath?: string;
  /** reject: what the rejected proposal would have done. Rejecting an
   *  archive means "keep it", which the Curator counts as activity. */
  rejected?: SkillAction | "archive";
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
  try {
    await tryRename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
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
async function archive(state: string, p: Proposal, approved: boolean): Promise<SkillEvent> {
  const to = await freeDir(p.archiveTo ?? join(state, "archive", p.name));
  await mkdir(dirname(to), { recursive: true });
  await moveDir(dirname(p.path), to);
  const e: SkillEvent = {
    id: p.id,
    ts: new Date().toISOString(),
    action: "archive",
    actor: "curator",
    ...(approved ? { approved: true } : {}),
    scope: p.scope,
    name: p.name,
    path: p.path,
    project: p.project,
    ...(p.before !== null ? { beforeSha: await saveBlob(state, p.before) } : {}),
    ...(p.reason ? { reason: p.reason } : {}),
    archivePath: to,
  };
  await record(state, e);
  return e;
}

async function apply(state: string, p: Proposal, approved: boolean): Promise<SkillEvent> {
  if (p.action === "archive") return archive(state, p, approved);
  await writeSkillFile(p.path, p.after);
  markViewed(p.path);
  const e: SkillEvent = {
    id: p.id,
    ts: new Date().toISOString(),
    action: p.action,
    actor: "agent",
    ...(approved ? { approved: true } : {}),
    scope: p.scope,
    name: p.name,
    path: p.path,
    project: p.project,
    ...(p.before !== null ? { beforeSha: await saveBlob(state, p.before) } : {}),
    afterSha: await saveBlob(state, p.after),
    ...(p.reason ? { reason: p.reason } : {}),
  };
  await record(state, e);
  return e;
}

// ─── the operations the tool exposes ────────────────────────────────────────

export type Outcome =
  | { status: "applied"; path: string; event: SkillEvent }
  | { status: "pending"; proposal: Proposal }
  | { status: "error"; error: string };

export function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Apply now, or park as a proposal, per the "New skills wait for my OK" setting. */
export async function submit(paths: SynthraPaths, p: Proposal): Promise<Outcome> {
  if (loadConfig().skillApproval) {
    await mkdir(pendingDir(paths.skillState), { recursive: true });
    await writeFile(
      join(pendingDir(paths.skillState), `${p.id}.json`),
      JSON.stringify(p, null, 2),
      "utf8",
    );
    return { status: "pending", proposal: p };
  }
  const event = await apply(paths.skillState, p, false);
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

/** The skill to change, if Synthra may change it. */
async function changeable(
  paths: SynthraPaths,
  name: string,
  scope: SkillScope | undefined,
): Promise<{ ok: SkillInfo & { text: string } } | { error: string }> {
  const s = await findSkill(paths, name, scope);
  if (!s) return { error: `No skill named "${name}"${scope ? ` in ${scope}` : ""}.` };
  if (!s.learned) {
    return {
      error: `"${name}" wasn't written by Synthra, so Synthra won't change it. Suggest the change to the user instead.`,
    };
  }
  if (!wasViewed(s.path)) {
    return {
      error: `View "${name}" first (action "view"), then change it — so the change is made against what is really there.`,
    };
  }
  return { ok: s };
}

export interface PatchInput {
  scope?: SkillScope;
  name: string;
  old_string: string;
  new_string: string;
  reason?: string;
}

/** A targeted fix: one exact piece of SKILL.md replaced. */
export async function patchSkill(paths: SynthraPaths, input: PatchInput): Promise<Outcome> {
  const c = await changeable(paths, input.name, input.scope);
  if ("error" in c) return { status: "error", error: c.error };
  const s = c.ok;
  if (!input.old_string) return { status: "error", error: "old_string is empty." };
  const hits = s.text.split(input.old_string).length - 1;
  if (hits === 0)
    return {
      status: "error",
      error: "old_string isn't in the skill. View it again and copy the exact text.",
    };
  if (hits > 1)
    return {
      status: "error",
      error: `old_string appears ${hits} times; include more of the surrounding text so it is unique.`,
    };
  const patched = s.text.replace(input.old_string, () => input.new_string);
  const p = parseSkill(patched);
  if (!p.learned || p.name !== s.name) {
    return {
      status: "error",
      error:
        "The patch would change the skill's name or remove Synthra's mark. Change the body or the description only.",
    };
  }
  // Only Synthra's own frontmatter keys. Anything else — allowed-tools, hooks,
  // model — changes what the skill may do, and would hide in a diff as one line.
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
  const after = renderSkill(draft);
  return submit(paths, {
    id: newId(),
    ts: new Date().toISOString(),
    action: "patch",
    scope: s.scope,
    name: s.name,
    path: s.path,
    project: paths.projectRoot,
    before: s.text,
    after,
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

export interface EditInput {
  scope?: SkillScope;
  name: string;
  description?: string;
  body?: string;
  reason?: string;
}

/** A rewrite: new description and/or body; the name and the mark stay. */
export async function editSkill(paths: SynthraPaths, input: EditInput): Promise<Outcome> {
  const c = await changeable(paths, input.name, input.scope);
  if ("error" in c) return { status: "error", error: c.error };
  const s = c.ok;
  if (input.description === undefined && input.body === undefined) {
    return { status: "error", error: "Give a new description, a new body, or both." };
  }
  const old = parseSkill(s.text);
  const draft: SkillDraft = {
    name: s.name,
    description: (input.description ?? old.description ?? "").trim(),
    body: input.body ?? old.body,
    ...(old.origin ? { origin: old.origin } : {}),
  };
  const bad = checkDraft(draft);
  if (bad) return { status: "error", error: bad };
  return submit(paths, {
    id: newId(),
    ts: new Date().toISOString(),
    action: "edit",
    scope: s.scope,
    name: s.name,
    path: s.path,
    project: paths.projectRoot,
    before: s.text,
    after: renderSkill(draft),
    ...(input.reason ? { reason: input.reason } : {}),
  });
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
  const now = await readText(p.path);
  if (now !== p.before) {
    return {
      ok: false,
      error:
        p.before === null
          ? `A skill named "${p.name}" appeared since this was proposed. Reject this one.`
          : `"${p.name}" changed since this was proposed, so it can't be applied safely. Reject it, and ask the AI again.`,
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
