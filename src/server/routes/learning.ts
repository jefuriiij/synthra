// The Learning tab's data and answers:
//
//   /panels `learning` section   proposals waiting for the user, the last 30
//                                days of skill changes, the skills Synthra
//                                wrote
//   POST /skills/approve {id}    apply a proposal
//   POST /skills/reject {id}     drop it
//   GET /skills/blob?sha=…       a before/after text, for a diff
//
// Proposals carry their own before/after text; ledger events carry content
// hashes, read on demand — a month of changes would otherwise ride on every
// panel refresh.

import { readFile } from "node:fs/promises";

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
} from "../../learn/skills.js";
import { loadConfig } from "../../shared/config.js";
import type { ServerContext } from "../context.js";

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_MAX = 50;

export interface PanelProposal {
  id: string;
  ts: string;
  action: "create" | "patch" | "edit";
  scope: SkillScope;
  name: string;
  path: string;
  /** The description the skill will have. */
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
}

export async function readLearning(ctx: ServerContext, now = Date.now()): Promise<LearningSection> {
  const state = ctx.paths.skillState;
  const [pending, ledger, skills] = await Promise.all([
    listPending(state),
    readLedger(state),
    listSkills(ctx.paths),
  ]);
  const current = async (path: string) => readFile(path, "utf8").catch(() => null);
  return {
    approval: loadConfig().skillApproval,
    pending: await Promise.all(
      pending.map(async (p) => ({
        id: p.id,
        ts: p.ts,
        action: p.action,
        scope: p.scope,
        name: p.name,
        path: p.path,
        description: parseSkill(p.after).description ?? "",
        ...(p.reason ? { reason: p.reason } : {}),
        before: p.before,
        after: p.after,
        stale: (await current(p.path)) !== p.before,
      })),
    ),
    recent: ledger
      .filter((e) => now - Date.parse(e.ts) < RECENT_MS)
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
  };
}

export async function handleAnswer(
  verdict: "approve" | "reject",
  body: { id?: unknown },
  ctx: ServerContext,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof body?.id !== "string") return { ok: false, error: "`id` is required." };
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
