// The Claude Code instruction files that apply to one file, for graph_read
// (v0.43). Claude Code loads path-scoped rules (`.claude/rules/**/*.md` with a
// `paths:` list) and the CLAUDE.md files in a file's folders only when Claude
// touches the file with Read, Write, Edit or a single-file Bash read. A read
// through graph_read loads none of them (checked live on Claude Code 2.1.295:
// with Read, Claude saw a rule and the code breaking it; with graph_read, it
// saw no rules at all). So graph_read hands them over itself.
//
// Sources, as Claude Code loads them:
//   - CLAUDE.md and CLAUDE.local.md in every folder between the project root
//     and the file (the root's own load at session start, so they are left out);
//   - project rules in `.claude/rules/` and the user's in `~/.claude/rules/`,
//     any depth, whose `paths` match the file. Rules without `paths` load at
//     session start, so they are left out too.
//
// Matching copies what Claude Code did in a live test (2.1.295, Windows):
// gitignore rules, which the `ignore` package implements. `*.ts` matches in any
// folder, `src/*.ts` doesn't match `src/api/x.ts`, case doesn't matter, and
// braces are expanded first (`*.{ts,tsx}`). `paths` can be a YAML list, an
// inline `[...]` list or a comma-separated string.
//
// Limits: symlinked rules are skipped, `@imports` inside a CLAUDE.md are shown
// as written, and the section is cut at `readRulesMaxChars` (0 turns it off).
// Any error leaves the section out: a read must never fail over it.

import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";

import { loadConfig } from "../shared/config.js";

const MAX_RULE_FILES = 200;
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_PATTERNS = 256;
const FM_MAX_LINES = 60;

/** Split on commas outside braces and quotes. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "{") {
      depth++;
      cur += ch;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const unquote = (s: string): string => {
  const t = s.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0] as string)
    ? t.slice(1, -1)
    : t;
};

const items = (parts: string[]): string[] => parts.map(unquote).filter((p) => p.length > 0);

/** A rule file's `paths` (null: none, or not readable) and its text without
 *  the frontmatter. */
export function parseRule(md: string): { paths: string[] | null; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(md);
  if (!m) return { paths: null, body: md };
  const body = m[2] ?? "";
  const lines = (m[1] ?? "").split(/\r?\n/).slice(0, FM_MAX_LINES);
  const at = lines.findIndex((l) => /^paths:/.test(l));
  if (at < 0) return { paths: null, body };
  const value = (lines[at] as string).slice("paths:".length).trim();
  let paths: string[];
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) return { paths: null, body };
    paths = items(splitTopLevel(value.slice(1, -1)));
  } else if (value === "") {
    paths = [];
    for (const l of lines.slice(at + 1)) {
      const item = /^\s+-\s+(.*)$/.exec(l) ?? /^-\s+(.*)$/.exec(l);
      if (item) paths.push(unquote((item[1] as string).replace(/\s+#.*$/, "")));
      else if (l.trim() !== "") break;
    }
    paths = paths.filter((p) => p.length > 0);
  } else {
    paths = items(splitTopLevel(unquote(value)));
  }
  return { paths: paths.length > 0 ? paths : null, body };
}

/** `a/*.{ts,tsx}` becomes `a/*.ts` and `a/*.tsx`; nested braces too. */
export function expandBraces(pattern: string, out: string[] = []): string[] {
  if (out.length >= MAX_PATTERNS) return out;
  const open = pattern.indexOf("{");
  let depth = 0;
  let close = -1;
  for (let i = open; open >= 0 && i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (open < 0 || close < 0) {
    out.push(pattern);
    return out;
  }
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  for (const alt of splitTopLevel(pattern.slice(open + 1, close))) {
    expandBraces(head + alt + tail, out);
  }
  return out;
}

/** Whether any of a rule's `paths` matches a project-relative file path. */
export function rulePathsMatch(paths: string[], relPath: string): boolean {
  const patterns: string[] = [];
  for (const p of paths) expandBraces(p.replace(/^\.\//, ""), patterns);
  try {
    return ignore().add(patterns).ignores(relPath.replace(/\\/g, "/"));
  } catch {
    return false;
  }
}

/** One instruction file for the section: `readPath` is what Claude passes to
 *  Read for the full text. */
export interface InstructionDoc {
  readPath: string;
  text: string;
}

async function smallText(file: string): Promise<string | null> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The `.md` files under a rules folder, sorted, no symlinks, bounded. */
async function ruleFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_RULE_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (found.length >= MAX_RULE_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) found.push(r);
    }
  };
  await walk("", 0);
  return found;
}

/** The instruction files Claude Code would load on a Read of `relPath`. */
export async function instructionDocs(
  projectRoot: string,
  relPath: string,
  home: string = homedir(),
): Promise<InstructionDoc[]> {
  const docs: InstructionDoc[] = [];
  const rel = relPath.replace(/\\/g, "/");
  const folders = rel.split("/").slice(0, -1);
  for (let i = 1; i <= folders.length; i++) {
    const dir = folders.slice(0, i).join("/");
    for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
      const text = await smallText(join(projectRoot, dir, name));
      if (text?.trim()) docs.push({ readPath: `${dir}/${name}`, text: text.trim() });
    }
  }
  const roots: Array<[string, string]> = [[join(projectRoot, ".claude", "rules"), ".claude/rules"]];
  const userRules = join(home, ".claude", "rules");
  if (userRules !== roots[0]?.[0]) roots.push([userRules, "~/.claude/rules"]);
  for (const [dir, shown] of roots) {
    for (const file of await ruleFiles(dir)) {
      const text = await smallText(join(dir, file));
      if (!text) continue;
      const { paths, body } = parseRule(text);
      if (paths && body.trim() && rulePathsMatch(paths, rel)) {
        docs.push({ readPath: `${shown}/${file}`, text: body.trim() });
      }
    }
  }
  return docs;
}

/** The section's text, cut at `max` characters of rule text. "" for none. */
export function buildRulesFooter(docs: InstructionDoc[], max: number): string {
  if (docs.length === 0 || max <= 0) return "";
  const lines = [
    "📏 Rules for this file. Claude Code loads these when you Read it, but not for graph_read, so here they are:",
  ];
  let left = max;
  for (const d of docs) {
    if (left <= 0) {
      lines.push("", `### ${d.readPath}`, `[not shown: Read("${d.readPath}")]`);
      continue;
    }
    if (d.text.length <= left) {
      lines.push("", `### ${d.readPath}`, d.text);
      left -= d.text.length;
    } else {
      lines.push(
        "",
        `### ${d.readPath}`,
        d.text.slice(0, left).trimEnd(),
        `[cut: Read("${d.readPath}") for the rest]`,
      );
      left = 0;
    }
  }
  return lines.join("\n");
}

/** graph_read's rules section; "" when off, empty or anything goes wrong. */
export async function rulesFooter(
  projectRoot: string,
  relPath: string,
  home?: string,
  max: number = loadConfig().readRulesMaxChars,
): Promise<string> {
  if (max <= 0) return "";
  try {
    return buildRulesFooter(await instructionDocs(projectRoot, relPath, home), max);
  } catch {
    return "";
  }
}
