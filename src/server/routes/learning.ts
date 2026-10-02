// The Learning tab's data and answers:
//
//   /panels `learning` section   proposals waiting for the user, the last 30
//                                days of skill changes, the skills Synthra
//                                wrote
//   POST /skills/approve {id}    apply a proposal
//   POST /skills/reject {id}     drop it
//   GET /skills/blob?sha=…       a before/after text, for a diff
//   POST /skills/pin {path, on}  keep a skill out of the Curator's hands
//   POST /skills/restore {archivePath}   bring an archived skill back
//   POST /skills/delete {path}   the user deleted a skill in the IDE: archive it
//   POST /skills/answer-group {group, verdict}   every change of one merge
//   POST /curator/run            "Run now", ignoring the weekly clock
//
// Proposals carry their own before/after text; ledger events carry content
// hashes, read on demand — a month of changes would otherwise ride on every
// panel refresh.

import { readFile } from "node:fs/promises";

import { arsenalItemFile, clearArsenalCache, computeArsenal } from "../../dashboard/arsenal.js";
import {
  type CuratorStatus,
  type SkillAge,
  curatorStatus,
  runCurator,
  setPin,
} from "../../learn/curator.js";
import {
  type Proposal,
  type SkillEvent,
  type SkillScope,
  approveProposal,
  archiveSkill,
  listPending,
  listSkills,
  parseSkill,
  readBlob,
  readLedger,
  rejectProposal,
  ownership,
  restoreSkill,
  skillMdOf,
} from "../../learn/skills.js";
import { loadConfig } from "../../shared/config.js";
import { type SynthraPaths, pathKey, sameRoot } from "../../shared/paths.js";
import type { ServerContext } from "../context.js";

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_MAX = 50;

export interface PanelProposal {
  id: string;
  ts: string;
  /** "archive" comes from the Curator or a merge; "remove" deletes a support file. */
  action: "create" | "patch" | "edit" | "remove" | "archive";
  scope: SkillScope;
  name: string;
  /** The file it writes: SKILL.md, or a support file. */
  path: string;
  /** A support file, relative to the skill's folder ("references/maps.md"). */
  file?: string;
  /** "user": a change to the user's own skill. */
  owner?: "user";
  /** The skill's folder is a link to this folder: the change is saved there. */
  linkedTo?: string;
  /** A merge: the skill this one was merged into. */
  absorbedInto?: string;
  /** Changes of one merge share it; the IDE answers them together. */
  group?: string;
  /** The description the skill will have (or has, for an archive or a
   *  support file). */
  description: string;
  reason?: string;
  before: string | null;
  after: string;
  /** The file changed since the proposal was made: it can't be approved. */
  stale: boolean;
}

export interface PanelLearned {
  name: string;
  scope: SkillScope;
  path: string;
  description: string;
  origin?: string;
}

export interface LearningSection {
  /** "New skills wait for my OK". */
  approval: boolean;
  pending: PanelProposal[];
  /** Newest first. */
  recent: SkillEvent[];
  learned: PanelLearned[];
  curator: CuratorStatus;
}

/**
 * Which merge each waiting change belongs to, worked out here, never sent by
 * the AI: an archive "absorbed into" a skill starts the group of that skill,
 * and every waiting change to that skill's folder joins it.
 */
export function mergeGroups(pending: Proposal[]): Map<string, string> {
  const umbrellas = new Set(
    pending.flatMap((p) =>
      p.action === "archive" && p.absorbedPath ? [pathKey(p.absorbedPath)] : [],
    ),
  );
  const out = new Map<string, string>();
  for (const p of pending) {
    const key =
      p.action === "archive" && p.absorbedPath ? pathKey(p.absorbedPath) : pathKey(skillMdOf(p));
    if (umbrellas.has(key)) out.set(p.id, `merge:${key}`);
  }
  return out;
}

/** Only the project's paths: the dashboard reads this too, without a server. */
export async function readLearning(
  paths: SynthraPaths,
  now = Date.now(),
  { ages }: { ages?: Promise<SkillAge[]> } = {},
): Promise<LearningSection> {
  const state = paths.skillState;
  const [pending, ledger, skills, curator] = await Promise.all([
    listPending(state),
    readLedger(state),
    listSkills(paths),
    curatorStatus(paths, now, ages),
  ]);
  const current = async (path: string) => readFile(path, "utf8").catch(() => null);
  // ~/.synthra/skills is shared by every project: show this project's own
  // proposals and changes, and the global ones — never another repo's
  // project skill labelled "this project".
  const ours = (x: { scope: SkillScope; project: string }) =>
    x.scope === "global" || sameRoot(x.project, paths.projectRoot);
  const groups = mergeGroups(pending);
  return {
    approval: loadConfig().skillApproval,
    pending: await Promise.all(
      pending.filter(ours).map(async (p) => {
        const group = groups.get(p.id);
        // A support file: the skill it belongs to must still be there.
        const skillText = p.file ? await current(skillMdOf(p)) : null;
        const described = p.file
          ? (skillText ?? "")
          : p.action === "archive"
            ? (p.before ?? "")
            : p.after;
        return {
          id: p.id,
          ts: p.ts,
          action: p.action,
          scope: p.scope,
          name: p.name,
          path: p.path,
          ...(p.file ? { file: p.file } : {}),
          ...(p.owner ? { owner: p.owner } : {}),
          ...(p.linkedTo ? { linkedTo: p.linkedTo } : {}),
          ...(p.absorbedInto ? { absorbedInto: p.absorbedInto } : {}),
          ...(group ? { group } : {}),
          description: parseSkill(described).description ?? "",
          ...(p.reason ? { reason: p.reason } : {}),
          before: p.before,
          after: p.after,
          stale:
            (p.file !== undefined && skillText === null) || (await current(p.path)) !== p.before,
        };
      }),
    ),
    recent: ledger
      .filter((e) => ours(e) && now - Date.parse(e.ts) < RECENT_MS)
      .reverse()
      .slice(0, RECENT_MAX),
    learned: skills
      .filter((s) => s.learned)
      .map((s) => ({
        name: s.name,
        scope: s.scope,
        path: s.path,
        description: s.description,
        ...(s.origin ? { origin: s.origin } : {}),
      })),
    curator,
  };
}

export async function handleAnswer(
  verdict: "approve" | "reject",
  body: { id?: unknown },
  ctx: ServerContext,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof body?.id !== "string") return { ok: false, error: "`id` is required." };
  const p = (await listPending(ctx.paths.skillState)).find((x) => x.id === body.id);
  if (p && p.scope === "project" && !sameRoot(p.project, ctx.paths.projectRoot)) {
    return { ok: false, error: "That proposal belongs to another project. Answer it there." };
  }
  const r =
    verdict === "approve"
      ? await approveProposal(ctx.paths.skillState, body.id)
      : await rejectProposal(ctx.paths.skillState, body.id);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Approve or reject every change of one merge as one answer. Approving checks
 * every change is still fresh before it applies any, then applies them in
 * order (the umbrella's SKILL.md, its support files, then the archives) and
 * stops at the first failure.
 */
export async function handleAnswerGroup(
  body: { group?: unknown; verdict?: unknown },
  ctx: ServerContext,
): Promise<{ ok: boolean; applied: number; error?: string }> {
  const verdict = body?.verdict;
  if (typeof body?.group !== "string" || (verdict !== "approve" && verdict !== "reject")) {
    return { ok: false, applied: 0, error: "`group` and `verdict` are required." };
  }
  const state = ctx.paths.skillState;
  const pending = await listPending(state);
  const groups = mergeGroups(pending);
  const members = pending.filter((p) => groups.get(p.id) === body.group);
  if (members.length === 0)
    return { ok: false, applied: 0, error: "That merge isn't waiting any more." };
  if (members.some((p) => p.scope === "project" && !sameRoot(p.project, ctx.paths.projectRoot))) {
    return {
      ok: false,
      applied: 0,
      error: "That merge belongs to another project. Answer it there.",
    };
  }
  if (verdict === "reject") {
    for (const p of members) await rejectProposal(state, p.id);
    return { ok: true, applied: members.length };
  }
  const rank = (p: Proposal) => (p.action === "archive" ? 2 : p.file ? 1 : 0);
  const ordered = [...members].sort((a, b) => rank(a) - rank(b) || (a.ts < b.ts ? -1 : 1));
  const creates = new Set(
    ordered.filter((p) => p.action === "create" && !p.file).map((p) => pathKey(p.path)),
  );
  const current = (path: string) => readFile(path, "utf8").catch(() => null);
  for (const p of ordered) {
    const skillThere =
      !p.file || creates.has(pathKey(skillMdOf(p))) || (await current(skillMdOf(p))) !== null;
    if (!skillThere || (await current(p.path)) !== p.before) {
      return {
        ok: false,
        applied: 0,
        error: `"${p.name}" changed since this merge was proposed. Reject it, and ask the AI again.`,
      };
    }
  }
  let applied = 0;
  for (const p of ordered) {
    const r = await approveProposal(state, p.id);
    if (!r.ok) return { ok: false, applied, error: r.error };
    applied++;
  }
  return { ok: true, applied };
}

export async function handleBlob(sha: string | undefined, ctx: ServerContext) {
  const text = sha ? await readBlob(ctx.paths.skillState, sha) : null;
  return text === null ? { found: false as const } : { found: true as const, text };
}

/** A favorite (the IDE's star; "pin" in the files): any skill Claude Code can
 *  use here, plugin skills too. For a skill Synthra wrote it also means the
 *  Curator never archives it. */
export async function handlePin(
  body: { path?: unknown; on?: unknown },
  ctx: ServerContext,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof body?.path !== "string") return { ok: false, error: "`path` is required." };
  const key = pathKey(body.path);
  let path = (await listSkills(ctx.paths)).find((s) => pathKey(s.path) === key)?.path;
  if (!path) {
    // A plugin's or a synced skill: only the scan knows it. No await between
    // the scan and arsenalItemFile.
    const data = await computeArsenal(ctx.paths.projectRoot);
    path = data.skills
      .map((i) => arsenalItemFile("skills", i))
      .find((f): f is string => f !== undefined && pathKey(f) === key);
  }
  if (!path) return { ok: false, error: "That isn't a skill Claude Code can use here." };
  await setPin(ctx.paths.skillState, path, body.on !== false);
  return { ok: true };
}

export async function handleRestore(
  body: { archivePath?: unknown },
  ctx: ServerContext,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof body?.archivePath !== "string")
    return { ok: false, error: "`archivePath` is required." };
  const r = await restoreSkill(ctx.paths.skillState, body.archivePath);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** The user deleted a skill in the IDE (and confirmed it there): it moves to
 *  the archive now, unpinned, and Restore in the Learning tab brings it back.
 *  Only skills in this project's or the user's skills folder, and never one an
 *  installer put there: `npx skills` would bring it back. */
export async function handleDelete(
  body: { path?: unknown },
  ctx: ServerContext,
): Promise<{ ok: true; archivePath: string } | { ok: false; error: string }> {
  if (typeof body?.path !== "string" || !body.path) {
    return { ok: false, error: "`path` is required." };
  }
  const key = pathKey(body.path);
  const skill = (await listSkills(ctx.paths)).find((s) => pathKey(s.path) === key);
  if (!skill) {
    return { ok: false, error: "That isn't a skill in this project or in ~/.claude/skills." };
  }
  const own = await ownership(ctx.paths, skill);
  if (own.owner === "third_party") {
    return {
      ok: false,
      error: `"${skill.name}" was installed from ${own.source} with npx skills. Remove it with the tool that installed it.`,
    };
  }
  const r = await archiveSkill(ctx.paths, skill, { reason: "Deleted in the IDE." });
  if (!r.ok) return r;
  await setPin(ctx.paths.skillState, skill.path, false);
  clearArsenalCache();
  return { ok: true, archivePath: r.event.archivePath ?? "" };
}

export async function handleCuratorRun(ctx: ServerContext) {
  const run = await runCurator(ctx.paths, { force: true });
  return { ok: true, run };
}
