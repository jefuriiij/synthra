// POST /nudge — the Stop hook asks, after every Claude reply, whether to hold
// Claude for one more step: "is anything here worth remembering?". That is
// Hermes' memory nudge, done in the same chat instead of a background agent:
// the hook answers Claude Code with {"decision":"block","reason":…}, and Claude
// reads the reason and acts on it before it stops.
//
// It counts replies since either knowledge file last changed. Any change —
// the `memory` tool, another AI editing MEMORY.md by hand, you editing USER.md
// — resets the count, so a session that keeps its memory current is never
// nudged. A reply Claude makes BECAUSE of a nudge (stop_hook_active) neither
// counts nor gets nudged again, so the hook can't loop.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig } from "../../shared/config.js";
import type { ServerContext } from "../context.js";

export interface NudgeRequest {
  /** Claude Code sets this when the session is already continuing because of
   *  a Stop hook. */
  stop_hook_active?: boolean;
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
}
const states = new WeakMap<ServerContext, NudgeState>();

async function knowledgeHash(ctx: ServerContext): Promise<string> {
  const read = (p: string) => readFile(p, "utf8").catch(() => "");
  const [project, user] = await Promise.all([read(ctx.paths.memoryMd), read(ctx.paths.userMemory)]);
  return createHash("sha1").update(project).update("\0").update(user).digest("hex");
}

/** Plain ASCII on purpose: the Windows hook writes it through a console whose
 *  code page can mangle anything else. */
export function nudgeReason(every: number): string {
  return (
    `[Synthra memory check - every ${every} replies] Before you stop, look back over this ` +
    "conversation. Did you learn anything that will still matter in later sessions - about this " +
    "project (a convention, a gotcha, how to build, test or run something, where things live) or " +
    "about the user (their role, preferences, how they like to work)? If yes, save it now with " +
    "mcp__synthra__memory (target `project` or `user`): one short fact per entry, merged with " +
    "what is already there. If not, reply only: Nothing new to remember. Do not continue the task."
  );
}

export async function handleNudge(req: NudgeRequest, ctx: ServerContext): Promise<NudgeResponse> {
  const every = loadConfig().memoryNudgeEvery;
  if (!every || every <= 0 || req?.stop_hook_active === true) return {};

  const state = states.get(ctx) ?? { replies: 0 };
  states.set(ctx, state);
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

  if (state.replies < every) return {};
  state.replies = 0;
  return { reason: nudgeReason(every) };
}
