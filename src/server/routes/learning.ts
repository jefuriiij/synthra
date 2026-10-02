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
} from "../../learn/skills.js";
import { loadConfig } from "../../shared/config.js";
import { sameRoot } from "../../shared/paths.js";
import type { ServerContext } from "../context.js";

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_MAX = 50;

export interface PanelProposal {
  id: string;
  ts: string;
  /** "archive" comes from the Curator. */
  action: "create" | "patch" | "edit" | "archive";
  scope: SkillScope;
  name: string;
  path: string;
  /** The description the skill will have (or has, for an archive). */
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

export async function readLearning(ctx: ServerContext, now = Date.now()): Promise<LearningSection> {
  const state = ctx.paths.skillState;
  const [pending, ledger, skills, curator] = await Promise.all([
    listPending(state),
    readLedger(state),
    listSkills(ctx.paths),
    curatorStatus(ctx.paths, now),
  ]);
  const current = async (path: string) => readFile(path, "utf8").catch(() => null);
  // ~/.synthra/skills is shared by every project: show this project's own
  // proposals and changes, and the global ones — never another repo's
  // project skill labelled "this project".
  const ours = (x: { scope: SkillScope; project: string }) =>
    x.scope === "global" || sameRoot(x.project, ctx.paths.projectRoot);
  return {
    approval: loadConfig().skillApproval,
    pending: await Promise.all(
      pending.filter(ours).map(async (p) => ({
        id: p.id,
        ts: p.ts,
        action: p.action,
        scope: p.scope,
        name: p.name,
        path: p.path,
        description:
          parseSkill(p.action === "archive" ? (p.before ?? "") : p.after).description ?? "",
        ...(p.reason ? { reason: p.reason } : {}),
        before: p.before,
        after: p.after,
        stale: (await current(p.path)) !== p.before,
      })),
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
