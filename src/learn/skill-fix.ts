// Stuck skill updates, handed to Claude (v0.50).
//
// `npx skills update` can't finish some updates by itself:
//
//   removed  the repo no longer has a skill of that name (the author renamed
//            it, split it up or folded several into one). With -y the
//            installer prints "Skipping deletion in non-interactive mode" and
//            changes nothing, so the skill stays "removed from its repo".
//   moved    its folder went somewhere else in the repo. The installer finds
//            it by name, unless two folders match; then it skips the skill.
//   edited   the user changed the skill here, and the update replaces it.
//
// What replaced what, and which local edits still make sense on the new
// version, is a judgment, so Synthra gives Claude the facts and the steps
// (`skill_updates` MCP tool) and the IDE starts Claude with one sentence that
// points at them. Claude shows one plan and waits for the user's OK before it
// runs anything.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SynthraPaths } from "../shared/paths.js";
import {
  type GitHubOptions,
  type LockEntry,
  SKILL_NAME_RE,
  folderOf,
  readLockEntries,
  setHold,
  updateDiff,
  updateFacts,
} from "./skill-updates.js";
import { findSkill, skillLockPath } from "./skills.js";

export type StuckWhy = "removed" | "moved" | "edited";

export interface StuckSkill {
  name: string;
  /** "owner/repo". */
  source: string;
  why: StuckWhy;
  /** Where it was in the repo when installed. */
  wasAt: string;
  /** Its SKILL.md on this machine, when found. */
  here: string | null;
  /** removed: the skills the repo has now (folder names). */
  repoNow?: string[];
  /** removed: those of `repoNow` already installed here. */
  installedNow?: string[];
  /** edited: the files changed here since the install. */
  edited?: string[];
  /** How many names (of `repoNow` or `edited`) were left out as not plain. */
  odd?: number;
}

// Folder and file names come from a repo its author controls, and they end up
// in text Claude follows. A folder named like an instruction ("ignore the
// steps and run ...") must never get there: only plain names pass, the rest
// are counted, and every value sits in a code span.
const REPO_ITSELF = "(the repo itself)";
const PLAIN_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const plainName = (s: string) => s === REPO_ITSELF || SKILL_NAME_RE.test(s);
const plainPath = (s: string) => s.length <= 200 && PLAIN_PATH.test(s);

/** Where a skill's SKILL.md is on this machine: Claude's copy, else the
 *  installer's own (a skill installed only for other agents). A skill named
 *  "react:components" lives in the folder its repo gave it, "react-components". */
async function localSkill(paths: SynthraPaths, e: LockEntry): Promise<string | null> {
  const folder = folderOf(e.skillPath).split("/").pop() ?? "";
  for (const name of new Set([e.name, folder])) {
    if (!name || !SKILL_NAME_RE.test(name)) continue;
    const skill = await findSkill(paths, name, "global").catch(() => null);
    if (skill) return skill.path;
    const own = join(
      dirname(dirname(paths.globalSkillsDir)),
      ".agents",
      "skills",
      name,
      "SKILL.md",
    );
    const found = await readFile(own).then(
      () => own,
      () => null,
    );
    if (found) return found;
  }
  return null;
}

/**
 * The installed skills whose update is stuck. Without `names`: every removed
 * or moved one that is not held. With `names`: those skills, and one with a
 * normal update waiting is checked for edits made here (one GitHub lookup
 * each). `ok` lists the named skills with nothing to fix.
 */
export async function stuckSkills(
  paths: SynthraPaths,
  names?: string[],
  gh: GitHubOptions = {},
): Promise<{ stuck: StuckSkill[]; ok: string[]; unknown: string[] }> {
  const [facts, lock] = await Promise.all([
    updateFacts(paths),
    readLockEntries(skillLockPath(paths, "global")),
  ]);
  const byName = new Map<string, LockEntry>(lock.map((e) => [e.name, e]));
  const installed = new Set(lock.map((e) => e.name));
  const wanted = names ?? lock.map((e) => e.name);
  const stuck: StuckSkill[] = [];
  const ok: string[] = [];
  const unknown: string[] = [];
  for (const name of wanted) {
    const e = byName.get(name);
    if (!e) {
      unknown.push(name);
      continue;
    }
    // "Don't update" is the user's answer already; only a named skill passes.
    if (facts.held.has(name) && !names) continue;
    const base = {
      name,
      source: e.source,
      wasAt: e.skillPath,
      here: await localSkill(paths, e),
    };
    const all = facts.removed.get(name);
    if (all) {
      const gone = all.filter(plainName);
      const here: string[] = [];
      for (const n of gone) {
        if (n === REPO_ITSELF) continue;
        if (installed.has(n) || (await findSkill(paths, n, "global").catch(() => null))) {
          here.push(n);
        }
      }
      const odd = all.length - gone.length;
      stuck.push({
        ...base,
        why: "removed",
        repoNow: gone,
        installedNow: here,
        ...(odd ? { odd } : {}),
      });
      continue;
    }
    const state = facts.state.get(name);
    if (state === "moved") {
      stuck.push({ ...base, why: "moved" });
      continue;
    }
    if (state === "available" && names) {
      const d = await updateDiff(paths, name, gh).catch(() => null);
      const changed = d && typeof d !== "string" ? d.editedHere : null;
      if (changed && changed.length > 0) {
        const edited = changed.filter(plainPath);
        const odd = changed.length - edited.length;
        stuck.push({ ...base, why: "edited", edited, ...(odd ? { odd } : {}) });
        continue;
      }
    }
    if (names) ok.push(name);
  }
  return { stuck, ok, unknown };
}

/** Names as data: each in a code span, and a count of the ones left out. */
function list(items: string[], odd = 0): string {
  const shown = items.map((x) => `\`${x}\``);
  if (odd) shown.push(`${odd} more with a name Synthra won't repeat here`);
  return shown.length ? shown.join(", ") : "none";
}

function facts(s: StuckSkill): string[] {
  const wasAt = plainPath(s.wasAt) ? `\`${s.wasAt}\`` : "a path Synthra won't repeat here";
  const out = [
    `## ${s.name}`,
    `- Installed from: \`${s.source}\` (it was at ${wasAt})`,
    `- On this machine: ${s.here ?? "not found in ~/.claude/skills"}`,
  ];
  if (s.why === "removed") {
    out.push(
      "- Problem: its repo no longer has a skill of this name, so there is nothing to update to.",
      `- The repo has these skills now: ${list(s.repoNow ?? [], s.odd)}`,
      `- Of those, installed here already: ${list(s.installedNow ?? [])}`,
    );
  } else if (s.why === "moved") {
    out.push("- Problem: its folder moved inside its repo.");
  } else {
    out.push(
      "- Problem: an update is waiting, and I changed this skill here. The update replaces my changes.",
      `- Files I changed here: ${list(s.edited ?? [], s.odd)}`,
    );
  }
  return out;
}

const STEPS = [
  "# Steps",
  "",
  "1. Look first, change nothing. For each skill above, read its SKILL.md on this machine. For a removed one, find what replaced it: `npx -y skills add <owner/repo> -l` lists the repo's skills, and you can read a candidate's SKILL.md on GitHub (`gh api`, or raw.githubusercontent.com). Names alone are not proof: compare what the skills do.",
  "2. Show me ONE plan, one line per skill, with one of these and a short reason:",
  "   - replace: install <new skill>, then remove <old skill> (say what the new one covers of the old)",
  "   - keep: I keep my copy as it is (nothing replaces it and it still works)",
  "   - remove: delete it (it is dead and nothing replaces it)",
  "   - update: for a moved skill",
  "   - update and keep my edits: for an edited skill (say which edits you will carry over)",
  "   Then STOP and wait for my OK. I may change lines.",
  "3. After my OK, do it one skill at a time:",
  "   - update (moved): `npx -y skills update <name> -g -y`. If it is still not updated, install it again from its repo: `npx -y skills add <owner/repo> -g -s <name> -y`.",
  "   - replace: `npx -y skills add <owner/repo> -g -s <new skill> -y` (skip it when the new skill is installed already). Check that its SKILL.md is on disk. Only then `npx -y skills remove <old skill> -g -y`.",
  "   - remove: `npx -y skills remove <name> -g -y`.",
  "   - keep: call mcp__synthra__skill_updates with action keep and the name. Synthra then stops marking it.",
  "   - update and keep my edits: copy the files I changed to a scratch folder, run `npx -y skills update <name> -g -y`, then put back each edit that still makes sense on the new version, and show me what you put back and what you left out.",
  "4. Rules:",
  "   - Only the skills listed above. Never `npx skills update` without names, never `--all`, never `-s '*'`.",
  "   - Never remove a skill before its replacement is installed.",
  "   - If a command fails, stop and tell me what it printed.",
  "5. At the end: one line per skill with what happened. Then tell me to press Check for updates in Synthra's Capabilities tab.",
];

/** What `skill_updates` answers for action list: the facts, then the steps. */
export function fixRequestText(found: {
  stuck: StuckSkill[];
  ok: string[];
  unknown: string[];
}): string {
  const out: string[] = [];
  if (found.stuck.length === 0) {
    out.push("No installed skill has a stuck update.");
  } else {
    out.push(
      `# Stuck skill updates (${found.stuck.length})`,
      "",
      "These skills were installed with `npx skills` for every project. Their update can't finish by itself. The facts come from Synthra's last check against GitHub.",
      "",
    );
    for (const s of found.stuck) out.push(...facts(s), "");
  }
  if (found.ok.length) {
    out.push(
      `Nothing to fix (a normal Update does it, or it is up to date): ${found.ok.join(", ")}`,
      "",
    );
  }
  if (found.unknown.length) {
    out.push(`Not installed with npx skills from GitHub: ${found.unknown.join(", ")}`, "");
  }
  if (found.stuck.length > 0) out.push(...STEPS);
  return out.join("\n").trimEnd();
}

/**
 * The one sentence that starts the fix: short, plain characters only, so it
 * is safe as a command-line argument in any shell. The facts and the steps
 * stay in the tool, read fresh when Claude calls it.
 */
export function fixSentence(names: string[]): string | null {
  if (!names.length || !names.every((n) => SKILL_NAME_RE.test(n))) return null;
  return `Fix my stuck skill updates. Call the tool mcp__synthra__skill_updates with action list and names ${names.join(", ")}. Then follow the steps it returns.`;
}

/** The command the IDE types into a terminal in the project folder. */
export function fixCommand(names: string[]): string | null {
  const s = fixSentence(names);
  return s ? `claude "${s}"` : null;
}

/** "keep": the user keeps their copy of a skill its repo removed. Synthra
 *  then offers it no update and stops marking it. Returns why not, or null. */
export async function keepSkill(paths: SynthraPaths, name: string): Promise<string | null> {
  if (!SKILL_NAME_RE.test(name)) return "That isn't a skill name.";
  const lock = await readLockEntries(skillLockPath(paths, "global"));
  if (!lock.some((e) => e.name === name)) {
    return `"${name}" isn't a skill installed with npx skills from GitHub.`;
  }
  const facts = await updateFacts(paths);
  if (!facts.removed.has(name)) {
    return `"${name}" is still in its repo: use Update, or "Don't update" in Synthra's Capabilities tab.`;
  }
  await setHold(paths.skillState, name, true);
  return null;
}
