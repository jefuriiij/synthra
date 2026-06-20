// Bash exploration observer — OBSERVE-ONLY. The Moat blocks Grep/Glob, but the
// agent can still walk the codebase through the terminal (`rg foo src/`,
// `cat src/x.ts`, `find . -name …`), and every such call is a read the graph
// could have served in ~50 tokens. This module classifies those commands and
// logs them (with whether the graph COULD have answered) so the leak can be
// measured before deciding whether to block it. It NEVER blocks anything.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { retrieve } from "../../graph/retrieve.js";
import { loadConfig } from "../../shared/config.js";
import type { ServerContext } from "../context.js";
import { looksLikeNonSymbolQuery } from "./query-heuristics.js";

export type BashExploreKind = "search" | "read" | "list";

export interface BashExploration {
  /** search = grep/rg over the tree · read = cat/head of a source file · list = find/tree */
  kind: BashExploreKind;
  /** the underlying tool, e.g. "rg", "grep", "cat", "find" */
  tool: string;
  /** the search pattern (search) or the file/dir target (read/list) */
  query: string | null;
}

type Confidence = "low" | "medium" | "high";

// Read-only exploration tools. Allowlist, not denylist — anything not here
// (npm/git/node/tsc/make/docker/mkdir/rm/echo/curl…) is left alone.
const SEARCH_TOOLS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack"]);
const READ_TOOLS = new Set(["cat", "head", "tail", "less", "more", "bat", "tac"]);
const LIST_TOOLS = new Set(["find", "tree"]);

// File extensions Synthra parses or content-indexes — a `cat` of one of these is
// a whole-file read the graph could slice.
const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|cts|mts|cjs|mjs|py|pyi|svelte|vue|go|rs|java|kt|kts|php|rb|c|h|cpp|cc|cxx|hpp|cs|dart|json|md|css|html|hubl|sh|yml|yaml|toml)$/i;

/**
 * Quote-aware shell tokenizer. Splits on whitespace and the operators
 * `| || && ;`, but treats quoted runs as a single token so an operator inside a
 * pattern (`rg "foo|bar"`) is preserved rather than split. Quote characters are
 * dropped; their contents are kept.
 */
export function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  const flush = () => {
    if (hasContent) tokens.push(cur);
    cur = "";
    hasContent = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      hasContent = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true; // an empty quoted string is still a token
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      flush();
      let op = ch;
      if ((ch === "|" || ch === "&") && cmd[i + 1] === ch) {
        op += ch;
        i++;
      }
      tokens.push(op);
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
    hasContent = true;
  }
  flush();
  return tokens;
}

function isOperator(t: string): boolean {
  return t === "|" || t === "||" || t === "&&" || t === ";";
}

function splitSegments(tokens: string[]): string[][] {
  const segs: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (isOperator(t)) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

// Drop a leading `env` and any `VAR=value` assignment prefixes so the real
// command surfaces.
function commandTokens(seg: string[]): string[] {
  let i = 0;
  while (i < seg.length) {
    const t = seg[i] as string;
    if (t === "env") {
      i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return seg.slice(i);
}

function baseCmd(tok: string): string {
  return (tok.split(/[\\/]/).pop() ?? tok).toLowerCase();
}

function classifySegment(seg: string[]): BashExploration | null {
  const toks = commandTokens(seg);
  if (toks.length === 0) return null;
  const cmd = baseCmd(toks[0] as string);
  const rest = toks.slice(1);
  const flags = rest.filter((a) => a.startsWith("-"));
  const nonFlags = rest.filter((a) => !a.startsWith("-"));

  if (SEARCH_TOOLS.has(cmd)) {
    const pattern = nonFlags[0];
    if (!pattern) return null; // no pattern → not a meaningful search
    const recursive = flags.some(
      (f) => f === "-r" || f === "-R" || f === "--recursive" || /^-[a-zA-Z]*[rR]$/.test(f),
    );
    const rgLike = cmd === "rg" || cmd === "ripgrep" || cmd === "ag" || cmd === "ack";
    const hasPathArg = nonFlags.length > 1;
    // grep/egrep/fgrep with no path reads stdin — that's filtering another
    // command's output, not searching the codebase. rg/ag default to a recursive
    // cwd search, so they count even without an explicit path.
    if (!rgLike && !recursive && !hasPathArg) return null;
    return { kind: "search", tool: cmd, query: pattern };
  }

  if (READ_TOOLS.has(cmd)) {
    const file = nonFlags.find((a) => SOURCE_EXT.test(a));
    if (!file) return null; // reading stdin or a non-source file
    return { kind: "read", tool: cmd, query: file };
  }

  if (LIST_TOOLS.has(cmd)) {
    const nameIdx = rest.findIndex((a) => a === "-name" || a === "-iname" || a === "-path");
    const target = nameIdx >= 0 ? (rest[nameIdx + 1] ?? null) : (nonFlags[0] ?? ".");
    return { kind: "list", tool: cmd, query: target };
  }

  return null;
}

/**
 * Classify a Bash command as codebase exploration, or null if it isn't one we
 * recognize. Conservative: a write/redirect anywhere voids the whole command
 * (it's no longer a pure read), and only the allowlisted tools match.
 */
export function classifyBashCommand(command: string): BashExploration | null {
  if (!command || typeof command !== "string") return null;
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return null;
  // Any redirect → there's a side effect; not pure read-only exploration.
  if (tokens.some((t) => !isOperator(t) && t.includes(">"))) return null;

  const found = splitSegments(tokens)
    .map(classifySegment)
    .filter((x): x is BashExploration => x !== null);
  if (found.length === 0) return null;

  // Prefer a real symbol search over a file read over a directory listing.
  const prio: Record<BashExploreKind, number> = { search: 0, read: 1, list: 2 };
  found.sort((a, b) => prio[a.kind] - prio[b.kind]);
  return found[0] as BashExploration;
}

function graphHasFile(ctx: ServerContext, target: string): boolean {
  const base = target.split(/[\\/]/).pop() ?? target;
  for (const n of ctx.graph.nodes) {
    if (n.kind !== "file") continue;
    if (n.path === target || n.path.endsWith(`/${target}`) || n.path.split("/").pop() === base) {
      return true;
    }
  }
  return false;
}

const Q_MAX = 200;
const CMD_MAX = 300;
const trunc = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

async function logObservation(
  ctx: ServerContext,
  exp: BashExploration,
  confidence: Confidence | null,
  avoidable: boolean,
  command: string,
): Promise<void> {
  try {
    await mkdir(dirname(ctx.paths.bashLog), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      kind: exp.kind,
      tool: exp.tool,
      query: exp.query ? trunc(exp.query, Q_MAX) : null,
      confidence,
      avoidable,
      command: trunc(command, CMD_MAX),
    };
    await appendFile(ctx.paths.bashLog, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Best-effort — an unwritable disk must never affect the Bash call.
  }
}

/**
 * Observe a Bash tool call: if it's codebase exploration, record it (and whether
 * the graph could have answered) to bash_log.jsonl. NEVER returns a decision —
 * the caller always allows the command through. Opt out with SYN_NO_BASH_OBSERVE.
 */
export async function observeBash(
  input: Record<string, unknown>,
  ctx: ServerContext,
): Promise<void> {
  if (!loadConfig().bashObserve) return;
  const command = typeof input.command === "string" ? input.command : "";
  const exp = classifyBashCommand(command);
  if (!exp) return;

  let confidence: Confidence | null = null;
  let avoidable = false;

  if (exp.kind === "search" && exp.query) {
    // Mirror the Moat's would-block test so "avoidable" predicts a real block:
    // the graph is confident AND a symbol the query names actually matched.
    if (!looksLikeNonSymbolQuery(exp.query)) {
      const r = await retrieve(ctx.graph, exp.query);
      confidence = r.confidence;
      avoidable = r.confidence !== "low" && r.symbolMatched;
    }
  } else if (exp.kind === "read" && exp.query) {
    // A cat/head of a file the graph knows → graph_read could have sliced it.
    avoidable = graphHasFile(ctx, exp.query);
  }

  await logObservation(ctx, exp, confidence, avoidable, command);
}
