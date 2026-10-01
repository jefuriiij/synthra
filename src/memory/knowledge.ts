// The two knowledge files every AI reads first — Hermes' MEMORY.md / USER.md,
// made readable by any agent, not only Claude:
//
//   .synthra/MEMORY.md   this project: conventions, gotchas, how to run things.
//                        Git-tracked with the rest of .synthra/, so the team
//                        (and every AI on the repo) shares it, and each project
//                        keeps its own.
//   ~/.synthra/USER.md   the person: role, preferences, how they like to work.
//                        In the home folder on purpose: .synthra/ is committed,
//                        and a profile must not reach GitHub or a teammate's AI.
//
// Both are plain Markdown — a flat list of "- " bullets under a header — so an
// agent without Synthra's MCP tools (Codex, Cursor, …) can read and edit them
// by hand, following the rules AGENTS.md gives it. Both have a character
// limit, as Hermes does (2,200 / 1,375): a full file must be consolidated
// before it grows, which keeps what every session loads small and current.
//
// The `memory` tool rewrites only the bullet list. Whatever sits above the
// first bullet (the header, or a note a human added) is kept verbatim.

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadConfig } from "../shared/config.js";
import { updateTextFile } from "../shared/json-store.js";
import type { SynthraPaths } from "../shared/paths.js";

export type KnowledgeTarget = "project" | "user";

export const DEFAULT_LIMITS: Record<KnowledgeTarget, number> = { project: 3500, user: 2000 };

/** The file and limit for a target, from the project paths and SYN_*_CHARS. */
export function knowledgeLocation(
  paths: SynthraPaths,
  target: KnowledgeTarget,
): { path: string; limit: number } {
  const cfg = loadConfig();
  return target === "project"
    ? { path: paths.memoryMd, limit: cfg.memoryChars }
    : { path: paths.userMemory, limit: cfg.userChars };
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The header a new file starts with. Written once; never rewritten after. */
export function knowledgeHeader(target: KnowledgeTarget, limit: number): string {
  if (target === "project") {
    return [
      "# Project memory",
      "",
      "<!-- synthra-memory: What every AI should know about this project. Shared",
      `with the team in git. Limit: ${fmt(limit)} characters of bullets. One fact per`,
      '"- " bullet, as a flat list. When it is full, merge or remove old bullets',
      "before you add one. Never store secrets. -->",
      "",
    ].join("\n");
  }
  return [
    "# About the user",
    "",
    "<!-- synthra-memory: Who the user is and how they like to work. Private to",
    "this machine; never copy it into a project. Limit: " + `${fmt(limit)} characters`,
    'of bullets. One fact per "- " bullet, as a flat list. -->',
    "",
  ].join("\n");
}

// ─── parsing ────────────────────────────────────────────────────────────────

interface Parsed {
  /** Everything above the first bullet, verbatim. */
  preamble: string;
  entries: string[];
}

const BULLET = /^[-*] (.*)$/;

/**
 * A bullet starts at column 0 with "- " (or "* "). Any later line that is not
 * a new bullet — indented, or a stray paragraph — continues the bullet above
 * it, so nothing a hand edit leaves behind is lost.
 */
export function parseKnowledge(text: string): Parsed {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => BULLET.test(l));
  if (first === -1) return { preamble: text, entries: [] };
  const entries: string[] = [];
  for (const line of lines.slice(first)) {
    const m = BULLET.exec(line);
    if (m) {
      entries.push(m[1]!.trim());
      continue;
    }
    if (!line.trim()) continue;
    const last = entries.length - 1;
    entries[last] = `${entries[last]}\n${line.trim()}`;
  }
  return {
    preamble: lines.slice(0, first).join("\n"),
    entries: entries.filter((e) => e.length > 0),
  };
}

function render(preamble: string, entries: string[]): string {
  const body = entries.map((e) => `- ${e.split("\n").join("\n  ")}`).join("\n");
  const head = preamble.replace(/\s+$/, "");
  return `${head ? `${head}\n\n` : ""}${body}\n`;
}

/** What counts against the limit: the bullets' text, one per line. */
export const charCount = (entries: string[]) => entries.join("\n").length;

// ─── reading ────────────────────────────────────────────────────────────────

export interface KnowledgeFile {
  target: KnowledgeTarget;
  path: string;
  exists: boolean;
  entries: string[];
  chars: number;
  limit: number;
}

export async function readKnowledge(
  target: KnowledgeTarget,
  path: string,
  limit: number = DEFAULT_LIMITS[target],
): Promise<KnowledgeFile> {
  let text: string | null = null;
  try {
    text = await readFile(path, "utf8");
  } catch {
    text = null;
  }
  const entries = text === null ? [] : parseKnowledge(text).entries;
  return { target, path, exists: text !== null, entries, chars: charCount(entries), limit };
}

// ─── changing ───────────────────────────────────────────────────────────────

export type KnowledgeOp =
  | { action: "add"; content: string }
  | { action: "replace"; old_text: string; content: string }
  | { action: "remove"; old_text: string };

export type KnowledgeResult =
  | { ok: true; file: KnowledgeFile; changed: boolean }
  | { ok: false; error: string; file: KnowledgeFile };

// Zero-width and bidirectional controls: invisible in an editor, and the
// classic way to hide an instruction inside text every session will load.
export const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

// The shapes of secrets that most often end up pasted into notes. MEMORY.md is
// committed, so a key saved there is a key published.
export const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i,
];

/** The entry as it will be stored, or why it can't be. */
export function cleanEntry(raw: string): { text: string } | { error: string } {
  const text = raw
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/^[-*]\s+/, "")
    .trim();
  if (!text) return { error: "The entry is empty." };
  if (INVISIBLE.test(text)) return { error: "The entry contains invisible control characters." };
  if (text.includes("<!--") || text.includes("-->")) {
    return { error: "The entry can't contain HTML comment markers (<!-- or -->)." };
  }
  if (SECRETS.some((re) => re.test(text))) {
    return {
      error:
        "The entry looks like it contains a secret (a key, token or password). Never store secrets in memory.",
    };
  }
  return { text };
}

function locate(entries: string[], oldText: string): number | string {
  const needle = oldText.trim();
  if (!needle) return "old_text is empty: give a short piece of the entry to change.";
  const hits = entries.flatMap((e, i) => (e.includes(needle) ? [i] : []));
  if (hits.length === 0) return `No entry contains "${needle}".`;
  if (hits.length > 1) {
    // An exact match wins over longer entries that merely contain it.
    const exact = hits.filter((i) => entries[i] === needle);
    if (exact.length === 1) return exact[0]!;
    return `"${needle}" matches ${hits.length} entries. Use a longer, unique piece of the one to change.`;
  }
  return hits[0]!;
}

/** Apply every op in order, against the final budget. Pure. */
export function applyOps(
  entries: string[],
  ops: KnowledgeOp[],
  limit: number,
): { entries: string[] } | { error: string } {
  if (ops.length === 0) return { error: "No operations given." };
  const next = [...entries];
  for (const [n, op] of ops.entries()) {
    const where = ops.length > 1 ? `Operation ${n + 1}: ` : "";
    if (op.action === "add") {
      const c = cleanEntry(op.content ?? "");
      if ("error" in c) return { error: where + c.error };
      if (next.includes(c.text)) return { error: `${where}That entry is already there.` };
      next.push(c.text);
    } else if (op.action === "replace") {
      const i = locate(next, op.old_text ?? "");
      if (typeof i === "string") return { error: where + i };
      const c = cleanEntry(op.content ?? "");
      if ("error" in c) return { error: where + c.error };
      next[i] = c.text;
    } else if (op.action === "remove") {
      const i = locate(next, op.old_text ?? "");
      if (typeof i === "string") return { error: where + i };
      next.splice(i, 1);
    } else {
      return { error: `${where}Unknown action. Use add, replace or remove.` };
    }
  }
  const chars = charCount(next);
  // Shrinking is always allowed — that is how a file over its limit (after a
  // hand edit) gets back under it.
  if (chars > limit && chars > charCount(entries)) {
    return {
      error:
        `This would make the file ${fmt(chars)} characters; the limit is ${fmt(limit)}. ` +
        "Consolidate first: merge related entries into shorter ones with 'replace', or " +
        "'remove' entries that no longer matter. Several operations in one call are checked together.",
    };
  }
  return { entries: next };
}

/**
 * Change a knowledge file. Re-reads and re-applies on a concurrent write (an
 * AI editing the file by hand at the same moment), so neither change is lost.
 */
export async function updateKnowledge(
  target: KnowledgeTarget,
  path: string,
  ops: KnowledgeOp[],
  limit: number = DEFAULT_LIMITS[target],
): Promise<KnowledgeResult> {
  await mkdir(dirname(path), { recursive: true });
  let outcome: { entries: string[] } | { error: string } = { error: "Nothing was applied." };
  const result = await updateTextFile(path, (current) => {
    const parsed =
      current === null
        ? { preamble: knowledgeHeader(target, limit), entries: [] }
        : parseKnowledge(current);
    outcome = applyOps(parsed.entries, ops, limit);
    if ("error" in outcome) return null;
    return render(parsed.preamble, outcome.entries);
  });
  const file = await readKnowledge(target, path, limit);
  const final = outcome as { entries: string[] } | { error: string };
  if ("error" in final) return { ok: false, error: final.error, file };
  return { ok: true, file, changed: result.status === "written" };
}

/** Make an empty project file with its header, if there is none yet. */
export async function ensureProjectKnowledge(path: string, limit: number): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const r = await updateTextFile(path, (current) =>
    current === null ? knowledgeHeader("project", limit) : null,
  );
  return r.status === "written";
}

// ─── for the primer ─────────────────────────────────────────────────────────

/**
 * One file as the primer shows it. A file over its limit (a hand edit) still
 * loads — cut at twice the limit, so a runaway file can't flood the session —
 * and says so, so the agent consolidates it.
 */
export function knowledgeSection(f: KnowledgeFile, title: string, shownPath: string): string[] {
  if (f.entries.length === 0) return [];
  const lines = [`## ${title} (${shownPath} · ${fmt(f.chars)}/${fmt(f.limit)} chars)`];
  if (f.chars > f.limit) {
    lines.push(
      `_Over its limit — merge or remove entries with the \`memory\` tool before adding more._`,
    );
  }
  let used = 0;
  for (const e of f.entries) {
    used += e.length + 1;
    if (used > f.limit * 2) {
      lines.push("- …(cut: the file is far over its limit)");
      break;
    }
    lines.push(`- ${e.split("\n").join("\n  ")}`);
  }
  return lines;
}
