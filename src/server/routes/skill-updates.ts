// Updates for installed skills (the Capabilities tab):
//
//   POST /skills/updates/check            ask GitHub, keep the answer
//   GET  /skills/update-diff?name=x       what updating x would change
//   POST /skills/hold {name, on}          never offer x an update (or again)
//   POST /skills/update-command {names}   the command the IDE runs to update
//
// Only names in the lock file are taken; a held skill gets no command.

import {
  type CheckResult,
  type GitHubOptions,
  type UpdateDiff,
  checkUpdates,
  readHolds,
  readLockEntries,
  setHold,
  updateCommand,
  updateDiff,
} from "../../learn/skill-updates.js";
import { skillLockPath } from "../../learn/skills.js";
import type { ServerContext } from "../context.js";

type Fail = { ok: false; error: string };

const installed = async (ctx: ServerContext) =>
  new Set((await readLockEntries(skillLockPath(ctx.paths, "global"))).map((e) => e.name));

export async function handleCheckUpdates(
  ctx: ServerContext,
  gh: GitHubOptions = {},
): Promise<({ ok: true } & CheckResult) | Fail> {
  try {
    return { ok: true, ...(await checkUpdates(ctx.paths, gh)) };
  } catch (e) {
    return { ok: false, error: `The check failed: ${(e as Error).message}` };
  }
}

export async function handleUpdateDiff(
  name: unknown,
  ctx: ServerContext,
  gh: GitHubOptions = {},
): Promise<{ ok: true; diff: UpdateDiff } | Fail> {
  if (typeof name !== "string" || !(await installed(ctx)).has(name)) {
    return { ok: false, error: "That isn't a skill installed from GitHub." };
  }
  const d = await updateDiff(ctx.paths, name, gh);
  return typeof d === "string" ? { ok: false, error: d } : { ok: true, diff: d };
}

export async function handleHold(
  body: { name?: unknown; on?: unknown },
  ctx: ServerContext,
): Promise<{ ok: true } | Fail> {
  const name = body?.name;
  if (typeof name !== "string" || !(await installed(ctx)).has(name)) {
    return { ok: false, error: "That isn't a skill installed from GitHub." };
  }
  await setHold(ctx.paths.skillState, name, body.on === true);
  return { ok: true };
}

export async function handleUpdateCommand(
  body: { names?: unknown },
  ctx: ServerContext,
): Promise<{ ok: true; command: string } | Fail> {
  const names = Array.isArray(body?.names) ? body.names : [];
  const known = await installed(ctx);
  const held = await readHolds(ctx.paths.skillState);
  const take = [
    ...new Set(names.filter((n): n is string => typeof n === "string" && known.has(n))),
  ];
  const skip = take.filter((n) => held.has(n));
  if (skip.length) {
    return { ok: false, error: `${skip.join(", ")} is set to "Don't update".` };
  }
  const command = take.length === names.length ? updateCommand(take) : null;
  return command
    ? { ok: true, command }
    : { ok: false, error: "Only skills installed with npx skills can be updated here." };
}
