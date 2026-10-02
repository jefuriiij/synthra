// POST /nudge — the Stop hook asks, after every Claude reply, whether to hold
// Claude for one more step. Two of Hermes' nudges, done in the same chat
// instead of a background agent — the hook answers Claude Code with
// {"decision":"block","reason":…}, and Claude reads the reason and acts on it
// before it stops:
//
//   memory  every N replies since either knowledge file last changed: "is
//           anything here worth remembering?". Any change to MEMORY.md or
//           USER.md — the `memory` tool, another AI's hand edit, yours —
//           resets the count, so a session that keeps its memory current is
//           never asked.
//   skill   every N tool calls since a skill was last saved: "was that a
//           repeatable workflow worth a skill?". The hook reports the tool
//           calls of each reply; skill_manage resets the count.
//
// When both are due they become one question. A reply Claude makes BECAUSE of
// a nudge (stop_hook_active) neither counts nor gets nudged, so the hook can't
// loop.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig } from "../../shared/config.js";
import type { ServerContext } from "../context.js";

export interface NudgeRequest {
  /** Claude Code sets this when the session is already continuing because of
   *  a Stop hook. */
  stop_hook_active?: boolean;
  /** Tool calls in the reply that just ended (Stop hook 0.33+). */
  tool_calls?: number;
}

export interface NudgeResponse {
  /** Present when Claude should take one more step; the hook passes it on. */
  reason?: string;
}

/** Per server — one project. Reset by a restart, which is fine: a nudge is a
 *  reminder, not a schedule. */
interface NudgeState {
  replies: number;
  hash?: string;
  toolCalls: number;
  /** skill_manage saved something during the reply now in progress. */
  savedThisReply: boolean;
}
const states = new WeakMap<ServerContext, NudgeState>();

function stateOf(ctx: ServerContext): NudgeState {
  let s = states.get(ctx);
  if (!s) {
    s = { replies: 0, toolCalls: 0, savedThisReply: false };
    states.set(ctx, s);
  }
  return s;
}

/**
 * skill_manage saved (or proposed) a skill: the work so far is accounted for.
 * Only a flag — the save happens mid-reply, and the Stop hook reports that
 * whole reply's tool calls afterwards (the ones before the save included), so
 * zeroing the count here would just refill it and nudge right after a save.
 */
export function noteSkillSaved(ctx: ServerContext): void {
  stateOf(ctx).savedThisReply = true;
}

async function knowledgeHash(ctx: ServerContext): Promise<string> {
  const read = (p: string) => readFile(p, "utf8").catch(() => "");
  const [project, user] = await Promise.all([read(ctx.paths.memoryMd), read(ctx.paths.userMemory)]);
  return createHash("sha1").update(project).update("\0").update(user).digest("hex");
}

// The reasons are plain ASCII on purpose: the Windows hook writes them through
// a console whose code page can mangle anything else.

const MEMORY_QUESTION =
  "Did you learn anything that will still matter in later sessions - about this project (a " +
  "convention, a gotcha, how to build, test or run something, where things live) or about the " +
  "user (their role, preferences, how they like to work)? If yes, save it with " +
  "mcp__synthra__memory (target `project` or `user`): one short fact per entry, merged with " +
  "what is already there.";

const SKILL_QUESTION =
  "Was this work a non-trivial, repeatable workflow - several steps or tries that will come up " +
  "again (a release, a fix for a recurring error, this project's way of doing X)? If yes, save " +
  "it with mcp__synthra__skill_manage: if a skill already covers it, view it and patch it; " +
  "otherwise create one (scope `project` if it only applies to this repo, `global` if it is " +
  "reusable). Write the steps and the why, not a log of this session.";

export function nudgeReason(every: number): string {
  return (
    `[Synthra memory check - every ${every} replies] Before you stop, look back over this ` +
    `conversation. ${MEMORY_QUESTION} If not, reply only: Nothing new to remember. Do not ` +
    "continue the task."
  );
}

export function skillNudgeReason(calls: number): string {
  return (
    `[Synthra skill check - after ${calls} tool calls] Before you stop, look back over this ` +
    `work. ${SKILL_QUESTION} If not, reply only: No skill to save. Do not continue the task.`
  );
}

export function combinedNudgeReason(): string {
  return (
    "[Synthra review] Before you stop, look back over this conversation and answer two " +
    `questions. 1) Memory: ${MEMORY_QUESTION} 2) Skill: ${SKILL_QUESTION} If neither applies, ` +
    "reply only: Nothing to save. Do not continue the task."
  );
}

export async function handleNudge(req: NudgeRequest, ctx: ServerContext): Promise<NudgeResponse> {
  const cfg = loadConfig();
  const state = stateOf(ctx);
  if (req?.stop_hook_active === true) {
    // A nudged step: it neither counts nor gets nudged. A save in it still
    // resets the count.
    if (state.savedThisReply) state.toolCalls = 0;
    state.savedThisReply = false;
    return {};
  }

  let memoryDue = false;
  if (cfg.memoryNudgeEvery > 0) {
    const hash = await knowledgeHash(ctx);
    if (state.hash === undefined) {
      state.hash = hash;
      state.replies = 1;
    } else if (hash !== state.hash) {
      // Saved during this reply: start counting again.
      state.hash = hash;
      state.replies = 0;
    } else {
      state.replies += 1;
    }
    if (state.replies >= cfg.memoryNudgeEvery) {
      memoryDue = true;
      state.replies = 0;
    }
  }

  let skillDue = false;
  let calls = 0;
  if (cfg.skillNudgeEvery > 0) {
    const n = Number(req?.tool_calls);
    if (state.savedThisReply) {
      // A skill was saved in this reply: it and everything before it count
      // as done.
      state.toolCalls = 0;
    } else if (Number.isFinite(n) && n > 0) {
      // One reply can't plausibly make more than a few hundred calls; a wild
      // value is a broken hook, not a reason to nudge.
      state.toolCalls += Math.min(Math.floor(n), 500);
    }
    if (state.toolCalls >= cfg.skillNudgeEvery) {
      skillDue = true;
      calls = state.toolCalls;
      state.toolCalls = 0;
    }
  }

  state.savedThisReply = false;
  if (memoryDue && skillDue) return { reason: combinedNudgeReason() };
  if (memoryDue) return { reason: nudgeReason(cfg.memoryNudgeEvery) };
  if (skillDue) return { reason: skillNudgeReason(calls) };
  return {};
}
