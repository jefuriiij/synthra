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
//   POST /curator/run            "Run now", ignoring the weekly clock
//
// Proposals carry their own before/after text; ledger events carry content
// hashes, read on demand — a month of changes would otherwise ride on every
// panel refresh.

import { readFile } from "node:fs/promises";

import { type CuratorStatus, curatorStatus, runCurator, setPin } from "../../learn/curator.js";
import {
  type SkillEvent,
  type SkillScope,
  approveProposal,
  listPending,
  listSkills,
  parseSkill,
  readBlob,
  readLedger,
  rejectProposal,
  restoreSkill,
  skillMdOf,
} from "../../learn/skills.js";
import { loadConfig } from "../../shared/config.js";
import { type SynthraPaths, sameRoot } from "../../shared/paths.js";
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

/** Only the project's paths: the dashboard reads this too, without a server. */
export async function readLearning(
  paths: SynthraPaths,
  now = Date.now(),
): Promise<LearningSection> {
  const state = paths.skillState;
  const [pending, ledger, skills, curator] = await Promise.all([
    listPending(state),
    readLedger(state),
    listSkills(paths),
    curatorStatus(paths, now),
  ]);
  const current = async (path: string) => readFile(path, "utf8").catch(() => null);
  // ~/.synthra/skills is shared by every project: show this project's own
  // proposals and changes, and the global ones — never another repo's
  // project skill labelled "this project".
  const ours = (x: { scope: SkillScope; project: string }) =>
    x.scope === "global" || sameRoot(x.project, paths.projectRoot);
  return {
    approval: loadConfig().skillApproval,
    pending: await Promise.all(
      pending.filter(ours).map(async (p) => {
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

export async function handleBlob(sha: string | undefined, ctx: ServerContext) {
  const text = sha ? await readBlob(ctx.paths.skillState, sha) : null;
  return text === null ? { found: false as const } : { found: true as const, text };
}

/** Only a skill Synthra wrote can be pinned — the pin file holds nothing else. */
export async function handlePin(
  body: { path?: unknown; on?: unknown },
  ctx: ServerContext,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof body?.path !== "string") return { ok: false, error: "`path` is required." };
  const skill = (await listSkills(ctx.paths)).find((s) => s.path === body.path && s.learned);
  if (!skill) return { ok: false, error: "That isn't a skill Synthra wrote." };
  await setPin(ctx.paths.skillState, skill.path, body.on !== false);
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

export async function handleCuratorRun(ctx: ServerContext) {
  const run = await runCurator(ctx.paths, { force: true });
  return { ok: true, run };
}
