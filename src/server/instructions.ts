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
// Limits: symlinked rule files are skipped (a symlinked CLAUDE.md is followed,
// as Claude Code does for one that links to AGENTS.md), `@imports` inside a CLAUDE.md are shown
// as written, and the section is cut at `readRulesMaxChars` (0 turns it off).
// Any error leaves the section out: a read must never fail over it.

import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";

import { loadConfig } from "../shared/config.js";
import { pathKey } from "../shared/paths.js";

const MAX_RULE_FILES = 200;
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_PATTERNS = 256;
const FM_MAX_LINES = 60;

/** Split on commas outside braces and quotes. A quote opens only at the start
 *  of an item, so an apostrophe inside a path stays a plain character. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if ((ch === '"' || ch === "'") && cur.trim() === "") {
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

const cleanPatterns = (parts: string[]): string[] => parts.map(unquote).filter((p) => p.length > 0);

/** A YAML value without its trailing ` # comment` (a `#` inside quotes stays). */
function dropComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && s.slice(0, i).trim() === "") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(s[i - 1] as string))) {
      return s.slice(0, i).trim();
    }
  }
  return s.trim();
}

/** The items of a YAML block list (`- a` lines); comment lines are skipped. */
function blockItems(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const item = /^\s*-\s+(.*)$/.exec(l);
    if (item) out.push(dropComment(item[1] as string));
    else if (l.trim() !== "" && !l.trim().startsWith("#")) break;
  }
  return out;
}

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/** A rule file's `paths` (null: none, or not readable) and its text without
 *  the frontmatter. Not arsenal.ts's readFrontmatter: it joins a list with
 *  ", ", which can't be split again around `{a,b}` braces. */
export function parseRule(md: string): { paths: string[] | null; body: string } {
  const m = FRONTMATTER.exec(md);
  if (!m) return { paths: null, body: md };
  const body = m[2] ?? "";
  const lines = (m[1] ?? "").split(/\r?\n/).slice(0, FM_MAX_LINES);
  const at = lines.findIndex((l) => /^paths:/.test(l));
  if (at < 0) return { paths: null, body };
  const value = dropComment((lines[at] as string).slice("paths:".length));
  const raw = value.startsWith("[")
    ? value.endsWith("]")
      ? splitTopLevel(value.slice(1, -1))
      : []
    : value
      ? splitTopLevel(unquote(value))
      : blockItems(lines.slice(at + 1));
  const paths = cleanPatterns(raw);
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

/** A file's text when it is a small regular file. `follow` reads through a
 *  symlink: Claude Code follows a CLAUDE.md that links to AGENTS.md. */
async function smallText(file: string, follow = false): Promise<string | null> {
  try {
    const st = follow ? await stat(file) : await lstat(file);
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
    let entries: Dirent[];
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
      const readPath = `${dir}/${name}`;
      // Reading a CLAUDE.md itself: its text is already the answer.
      if (readPath === rel) continue;
      const text = await smallText(join(projectRoot, dir, name), true);
      if (text?.trim()) docs.push({ readPath, text: text.trim() });
    }
  }
  const projectRules = join(projectRoot, ".claude", "rules");
  const userRules = join(home, ".claude", "rules");
  // The same folder when the project is the home folder itself.
  const roots: Array<[string, string]> = [[projectRules, ".claude/rules"]];
  if (pathKey(userRules) !== pathKey(projectRules)) roots.push([userRules, "~/.claude/rules"]);
  for (const [dir, shown] of roots) {
    // All at once: graph_read is called often, and one by one 50 rules took
    // about 29 ms a read.
    const files = await ruleFiles(dir);
    const texts = await Promise.all(files.map((file) => smallText(join(dir, file))));
    files.forEach((file, i) => {
      const text = texts[i];
      if (!text) return;
      const { paths, body } = parseRule(text);
      if (paths && body.trim() && rulePathsMatch(paths, rel)) {
        docs.push({ readPath: `${shown}/${file}`, text: body.trim() });
      }
    });
  }
  return docs;
}

/** The section's text, cut at `max` characters of rule text. "" for none. */
export const RULES_HEADER =
  "📏 Rules for this file. Claude Code loads these when you Read it, but not for graph_read, so here they are:";

export function buildRulesFooter(docs: InstructionDoc[], max: number): string {
  if (docs.length === 0 || max <= 0) return "";
  const lines = [RULES_HEADER];
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
