// Idempotent patcher for the project's AGENTS.md — the instructions file that
// Codex, Cursor, GitHub Copilot, Gemini CLI and most other coding agents read
// by themselves. Synthra's block tells any of them where the project's shared
// knowledge lives (.synthra/MEMORY.md, CONTEXT.md, the user's USER.md, the
// skills) and how to keep the memory files small. Claude Code gets the same
// through CLAUDE.md and the session primer; this is for every other agent.
//
// Same rules as claude-md.ts: one block between versioned markers, any older
// block replaced, everything outside the markers left exactly as it was.
//
// Since v0.35 AGENTS.md is also where the project's rules go: a new one starts
// with the rules starter (`rulesSkeleton`) that CLAUDE.md used to carry, and
// CLAUDE.md imports this file, so Claude Code reads the same rules.

import { lstat, realpath } from "node:fs/promises";

import { loadConfig } from "../shared/config.js";
import { updateTextFile } from "../shared/json-store.js";
import type { PatchResult } from "./claude-md.js";

export const AGENTS_BLOCK_VERSION = 1;
/** The title a new AGENTS.md starts with (`syn remove` deletes a file that has
 *  nothing else left). */
export const AGENTS_TITLE = "# Instructions for AI agents";
export const AGENTS_BEGIN = `<!-- synthra-agents v${AGENTS_BLOCK_VERSION} BEGIN -->`;
export const AGENTS_END = `<!-- synthra-agents v${AGENTS_BLOCK_VERSION} END -->`;

const ANY_BLOCK_RE =
  /<!--\s*synthra-agents\s+v\d+\s+BEGIN\s*-->[\s\S]*?<!--\s*synthra-agents\s+v\d+\s+END\s*-->\s*/g;

/** Remove every synthra-agents block (any version). For `syn remove`. */
export function stripAgentsBlock(content: string): string {
  return content.replace(ANY_BLOCK_RE, "");
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function agentsBlock(limits = loadConfig()): string {
  return [
    AGENTS_BEGIN,
    "## Project knowledge (Synthra)",
    "",
    "This project keeps shared knowledge for AI agents in `.synthra/`. Read these",
    "before you start, and keep them current:",
    "",
    "1. **`.synthra/MEMORY.md`** — what every AI should know about this project:",
    "   conventions, gotchas, how to build, test and run it, where things live.",
    "   Shared with the team in git.",
    "2. **`.synthra/CONTEXT.md`** — what is being worked on now: the current task,",
    "   recent decisions, next steps. On a branch other than the default one it is",
    "   `.synthra/branches/<branch>/CONTEXT.md`. Synthra generates it; don't edit it.",
    "3. **`~/.synthra/USER.md`** — about the person you work with, if the file",
    "   exists: role, preferences, how they like to work. Private to this machine;",
    "   never copy it into the project.",
    "4. **Skills** — step-by-step guides in `.claude/skills/<name>/SKILL.md` (this",
    "   project) and `~/.claude/skills/<name>/SKILL.md` (all projects). When a task",
    "   matches a skill's `description`, read that skill and follow it.",
    "",
    "### Keeping the memory files useful",
    "",
    "- Add an entry when you learn something that will still matter in later",
    "  sessions. Not task progress: what you are doing right now changes too fast.",
    "- One fact per `- ` bullet, as a flat list. Keep each one short.",
    `- Limits: MEMORY.md ${fmt(limits.memoryChars)} characters of bullets, USER.md ${fmt(limits.userChars)}.`,
    "  When a file is full, merge related bullets or remove ones that no longer",
    "  matter before you add one.",
    "- Never store secrets: keys, tokens, passwords.",
    "- If Synthra's MCP tools are available to you, change these files with",
    "  `memory` (it checks the limits), save a repeatable workflow as a skill",
    "  with `skill_manage`, and find code with `graph_continue` and `graph_read`.",
    "",
    "_This block is managed by Synthra. Edits inside the BEGIN/END markers",
    "are overwritten on every `syn .` run._",
    AGENTS_END,
  ].join("\n");
}

/**
 * The file to actually write. Repos often symlink CLAUDE.md and AGENTS.md to
 * one another; an atomic write (temp file + rename) on the link itself would
 * replace the link with a plain file and silently split them. Writing through
 * to the real file keeps the link — and the shared file gets both blocks,
 * which is harmless: each tool reads the part meant for it.
 */
export async function writeTarget(path: string): Promise<string> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await realpath(path);
  } catch {
    // Missing, or a dangling link: write the path as given.
  }
  return path;
}

/**
 * The rules starter a new AGENTS.md begins with: the durable "how and why" the
 * graph can't infer. It lives OUTSIDE Synthra's markers, so later `syn .` runs
 * never touch what the user fills in.
 */
export function rulesSkeleton(projectName: string): string {
  return [
    `# ${projectName}`,
    "",
    "> Rules for AI coding agents in this project. Claude Code, Codex, Cursor,",
    "> Copilot, Gemini CLI and others all read this file. Synthra's map already",
    "> knows the code's structure (files, symbols, imports). Write here what it",
    "> can't infer: how to run the project, its conventions, and the reasons",
    "> behind them. Keep it short, and delete the prompts you don't need.",
    ">",
    "> Rules the team agrees on go here. Facts an AI learns while it works go to",
    "> `.synthra/MEMORY.md`.",
    "",
    "## Build & test",
    "",
    "- TODO: install dependencies, build",
    "- TODO: run the tests, lint, type check",
    "- TODO: run the app locally",
    "",
    "## Conventions",
    "",
    "- TODO: code style, naming, and file layout to follow",
    "",
    "## Key decisions",
    "",
    '- TODO: choices that are not obvious, and why ("we use X, not Y, because ...")',
    "",
    "## Gotchas",
    "",
    '- TODO: traps, and things like "don\'t touch X without Y"',
    "",
    "_Synthra manages its own block below. Leave it as it is._",
    "",
  ].join("\n");
}

export interface AgentsMdOptions {
  /** Used for the starter's title. */
  projectName?: string;
  /**
   * Start the file with the rules starter when it holds nothing of the user's
   * yet (missing, or only Synthra's title and block from 0.33/0.34). `syn .`
   * turns it off when the user already keeps rules in CLAUDE.md, so they don't
   * get a second, empty set here.
   */
  scaffold?: boolean;
}

export async function patchAgentsMd(
  path: string,
  { projectName, scaffold = false }: AgentsMdOptions = {},
): Promise<PatchResult> {
  const block = agentsBlock();
  const name = projectName || "this project";
  let created = false;
  const result = await updateTextFile(await writeTarget(path), (existing) => {
    if (existing === null) {
      created = true;
      return scaffold
        ? `${rulesSkeleton(name).trimEnd()}\n\n${block}\n`
        : `${AGENTS_TITLE}\n\n${block}\n`;
    }
    created = false;
    // Strip, trim, re-append with one blank line: idempotent, so an unchanged
    // block means no write (see patchClaudeMd for why that matters).
    const base = existing.replace(ANY_BLOCK_RE, "").replace(/\s+$/, "");
    if (scaffold && (base.length === 0 || base === AGENTS_TITLE)) {
      return `${rulesSkeleton(name).trimEnd()}\n\n${block}\n`;
    }
    return base.length ? `${base}\n\n${block}\n` : `${block}\n`;
  });
  if (result.status === "unchanged") return { created: false, updated: false, skipped: true };
  return created
    ? { created: true, updated: false, skipped: false }
    : { created: false, updated: true, skipped: false };
}
