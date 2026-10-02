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
// loop. And the stop right after a nudge is never nudged either, marker or
// not: if Claude Code ever left stop_hook_active out, a nudged step that made
// enough tool calls would otherwise be nudged again, and again.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadConfig } from "../../shared/config.js";
import type { ServerContext } from "../context.js";

export interface NudgeRequest {
  /** Claude Code sets this when the session is already continuing because of
   *  a Stop hook. */
  stop_hook_active?: boolean;
  /** Tool calls in the reply that just ended (Stop hook 0.33+). */
  tool_calls?: number;
}

/** One line of .synthra-graph/nudge_log.jsonl: a reminder that fired. The
 *  dashboard compares these with the saves that followed. */
export interface NudgeLogEntry {
  ts: string;
  kind: "memory" | "skill" | "both";
}

async function logNudge(ctx: ServerContext, kind: NudgeLogEntry["kind"]): Promise<void> {
  try {
    await mkdir(dirname(ctx.paths.nudgeLog), { recursive: true });
    const entry: NudgeLogEntry = { ts: new Date().toISOString(), kind };
    await appendFile(ctx.paths.nudgeLog, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // best effort: a reminder never fails over its log line
  }
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
  /** The last stop got a reason: the next stop is the step it asked for. */
  justNudged: boolean;
}
const states = new WeakMap<ServerContext, NudgeState>();

function stateOf(ctx: ServerContext): NudgeState {
  let s = states.get(ctx);
  if (!s) {
    s = { replies: 0, toolCalls: 0, savedThisReply: false, justNudged: false };
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

// Update first, create last (Hermes' rule): one hard task is not a new kind of
// work, and asking "was this hard?" filled the library with one skill per UI
// effect. The question is what a skill should HOLD, and where it goes.
const SKILL_QUESTION =
  "Did this work teach a reusable procedure, or a correction from the user, that a skill " +
  "should hold? If yes, use mcp__synthra__skill_manage and take the FIRST step that fits: " +
  "1) a skill you used in this task: view it and patch it; 2) an existing skill for the same " +
  "kind of work (list, then view): patch it; 3) detail that is only needed sometimes: add " +
  "references/<topic>.md under that skill with write_file, plus a one-line pointer in its " +
  "SKILL.md; 4) only if nothing fits, create a skill named for the CLASS of work " +
  "(css-motion-effects, not rail-travelling-light). A name that only fits today's task is " +
  "wrong: one UI effect, component, error or ticket is not a class. Write rules with one " +
  "clause of why, not a story of this session. Do not save setup failures, claims that a tool " +
  "is broken, errors that went away, or one-off tasks. A preference about this kind of task " +
  "goes into its skill; facts about one client or project go to .synthra/MEMORY.md " +
  "(mcp__synthra__memory) or a project-scope skill, never a global skill.";

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
    `work. ${SKILL_QUESTION} If nothing qualifies, reply only: No skill to save. That is a ` +
    "normal answer. Do not continue the task."
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
  if (req?.stop_hook_active === true || state.justNudged) {
    // A nudged step: it neither counts nor gets nudged. A save in it still
    // resets the count.
    if (state.savedThisReply) state.toolCalls = 0;
    state.savedThisReply = false;
    state.justNudged = false;
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
  state.justNudged = memoryDue || skillDue;
  if (state.justNudged)
    await logNudge(ctx, memoryDue && skillDue ? "both" : memoryDue ? "memory" : "skill");
  if (memoryDue && skillDue) return { reason: combinedNudgeReason() };
  if (memoryDue) return { reason: nudgeReason(cfg.memoryNudgeEvery) };
  if (skillDue) return { reason: skillNudgeReason(calls) };
  return {};
}
