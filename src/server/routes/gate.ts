// POST /gate — PreToolUse hook calls this with the tool name + arguments.
// THE MOAT — improvement #1. Strategy:
//   - For Grep/Glob: extract the search pattern, run retrieve().
//   - If recent human activity touches a file matching the query → ALLOW
//     even at high confidence (the user's head is in that file; static
//     context may be stale).
//   - If confidence === "high" and no recent overlap → BLOCK. The deny reason
//     carries the answer: exact file::symbol graph_read targets + one-line
//     signatures, so the agent never needs the whole-file Read fallback.
//   - Otherwise → ALLOW.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { retrieve } from "../../graph/retrieve.js";
import type { RetrievalResult } from "../../graph/retrieve.js";
import { tokenizeQuery } from "../../graph/rank.js";
import type { GraphSchema, SymbolNode } from "../../graph/types.js";
import { loadConfig } from "../../shared/config.js";
import type { ServerContext } from "../context.js";

export interface GateRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface GateResponse {
  decision: "allow" | "block";
  reason?: string;
}

const BLOCKABLE_TOOLS = new Set(["Grep", "Glob"]);
const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

function extractQuery(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const query = typeof input.query === "string" ? input.query : "";
    return (pattern || query).trim() || null;
  }
  if (toolName === "Glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    return pattern.replace(/[*?/\\.]+/g, " ").trim() || null;
  }
  return null;
}

// Heuristic: does this Grep pattern target markup / CSS / attributes / literals
// rather than a code symbol? The graph only indexes symbols, so blocking these
// and redirecting to graph_read just forces a fallback Read. Conservative — only
// fires on syntax that never appears in a bare identifier search.
function looksLikeNonSymbolQuery(pattern: string): boolean {
  // HTML / JSX tag: "<div", "</", "<svg"
  if (/<\/?[a-zA-Z]/.test(pattern)) return true;
  // Hyphenated attribute assignment: "data-tour=", "aria-label=" ('-' is not a
  // valid identifier char, so this is markup, not a symbol).
  if (/[a-zA-Z][\w-]*-[\w-]*\s*=/.test(pattern)) return true;
  // CSS rule / object brace: ".content{", "{ color"
  if (/\{/.test(pattern)) return true;
  // Escaped-dot class / member selector: "\.filter-bar", "\.gs"
  if (/\\\.[a-zA-Z]/.test(pattern)) return true;
  // CSS property value or units: ": 100%", "12px", "1.5rem", "50%"
  if (/:\s*\d/.test(pattern) || /\d(?:px|rem|em|vh|vw)\b/.test(pattern) || /\d%/.test(pattern)) {
    return true;
  }
  // CSS custom property: "var(--brand)", "--sidebar" — a "--" prefix is never a
  // valid code identifier, so this is styling the graph doesn't index.
  if (/--[a-zA-Z]/.test(pattern)) return true;
  // Hex color literal: "#fff", "#0a0a0a".
  if (/#[0-9a-fA-F]{3,8}\b/.test(pattern)) return true;
  // Kebab-case search ("cw-code-chip", "data-tour") — hyphens aren't valid in
  // JS/TS/Python identifiers, so it's a CSS class / HTML attribute / custom
  // element. Only treat it as non-symbol when EVERY alternation branch is kebab,
  // so a mixed query like "fetchWith429Retry|Retry-After" (real symbol + a
  // hyphenated header) still blocks. Strip regex char-classes first so a range
  // like "[a-z]" isn't mistaken for a kebab token.
  const branches = pattern
    .replace(/\[[^\]]*\]/g, "")
    .split("|")
    .map((b) => b.trim())
    .filter(Boolean);
  const isKebab = (b: string) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(b);
  if (branches.length > 0 && branches.every(isKebab)) return true;
  return false;
}

// A recently-touched file "matches" the query if a query token appears in its
// PATH or in its graph-node KEYWORDS (file contents). The content-keyword check
// (#3) means a recent save of e.g. auth.ts relaxes `Grep "login"` when auth.ts
// contains login — not only when the path itself contains the token.
function recentlyTouchedMatchesQuery(
  recentPaths: string[],
  queryTokens: Set<string>,
  graph: GraphSchema,
): string[] {
  if (recentPaths.length === 0) return [];

  // Pull keywords for the recently-touched files in a single graph pass.
  const recent = new Set(recentPaths);
  const keywordsByPath = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.kind === "file" && recent.has(n.path)) keywordsByPath.set(n.path, n.keywords);
  }

  const matches: string[] = [];
  for (const path of recentPaths) {
    const lower = path.toLowerCase();
    let matched = false;
    for (const t of queryTokens) {
      if (lower.includes(t)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const kw of keywordsByPath.get(path) ?? []) {
        if (queryTokens.has(kw)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) matches.push(path);
  }
  return matches;
}

// Block hints can run to ~1200 chars; the log (and the dashboard /data payload
// built from it) only needs enough to identify the decision, so the stored
// reason is truncated and the full hint size is kept as a separate count.
const LOG_REASON_MAX_CHARS = 240;

async function logDecision(
  ctx: ServerContext,
  toolName: string,
  query: string | null,
  decision: "allow" | "block",
  reason: string | undefined,
  hintChars?: number,
): Promise<void> {
  try {
    await mkdir(dirname(ctx.paths.gateLog), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      decision,
      query,
      reason:
        reason && reason.length > LOG_REASON_MAX_CHARS
          ? `${reason.slice(0, LOG_REASON_MAX_CHARS)}…`
          : reason,
      ...(hintChars === undefined ? {} : { hint_chars: hintChars }),
    };
    await appendFile(ctx.paths.gateLog, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Durability is best-effort; an unwritable disk shouldn't fail the gate.
  }
}

const SIG_LINE_MAX_CHARS = 140;

// How relevant is a symbol name to the query? Mirrors the packer's inline
// scoring: exact token match dominates, substring containment is a weak hit.
function scoreSymbolName(name: string, qTokens: string[]): number {
  const lower = name.toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (t === lower) score += 3;
    else if (t.length >= 3 && lower.includes(t)) score += 1;
  }
  return score;
}

/**
 * Render the deny reason for a block. Instead of bare file paths (which sent
 * agents into whole-file Read fallbacks — see the dogfood log), the hint
 * delivers copy-pasteable namespaced graph_read targets plus one-line
 * signatures for the query's best symbols. Signatures only, no bodies: the
 * hint lands in the transcript on every block, so its own size is a cost.
 */
export function buildBlockHint(
  query: string,
  retrieval: RetrievalResult,
  graph: GraphSchema,
  toolName: string,
  maxChars = loadConfig().gateHintMaxChars,
): string {
  const topFiles = retrieval.files.slice(0, 3);
  const topPaths = new Set(topFiles.map((f) => f.path));

  const symsByFile = new Map<string, SymbolNode[]>();
  for (const n of graph.nodes) {
    if (n.kind !== "symbol" || !topPaths.has(n.file)) continue;
    const list = symsByFile.get(n.file);
    if (list) list.push(n);
    else symsByFile.set(n.file, [n]);
  }

  const qTokens = tokenizeQuery(query);
  const entries: string[] = [];
  for (const f of topFiles) {
    const syms = (symsByFile.get(f.path) ?? []).slice().sort((a, b) => a.start_line - b.start_line);
    if (syms.length === 0) {
      // Content-indexed only (no symbols) — still point at the slice tool.
      entries.push(`• mcp__synthra__graph_read("${f.path}")`);
      continue;
    }
    const scored = syms
      .map((s) => ({ s, score: scoreSymbolName(s.name, qTokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    // Best 1–2 query-relevant symbols; when nothing scores, the file's first
    // symbol still gives the agent a foothold into the file.
    const picks = scored.length > 0 ? scored.slice(0, 2).map((x) => x.s) : syms.slice(0, 1);
    for (const s of picks) {
      const sig = `L${s.start_line}: ${s.signature.trim()}`;
      const sigLine =
        sig.length > SIG_LINE_MAX_CHARS ? `${sig.slice(0, SIG_LINE_MAX_CHARS - 1)}…` : sig;
      entries.push(`• mcp__synthra__graph_read("${f.path}::${s.name}")\n  ${sigLine}`);
    }
  }

  const header =
    `Synthra blocked this ${toolName} — ${retrieval.confidence}-confidence context for "${query}" already exists.\n` +
    `Read symbols directly (~50 tokens each) instead of whole files:\n`;
  const footer = `\nFull pack: mcp__synthra__graph_continue("${query}")`;

  const parts: string[] = [];
  let used = header.length + footer.length + 1;
  for (const e of entries) {
    if (used + e.length + 1 > maxChars) break; // drop whole entries, never mid-entry
    parts.push(e);
    used += e.length + 1;
  }

  if (parts.length === 0) {
    // Degenerate budget — fall back to the legacy path list, namespaced.
    const top = topFiles.map((f) => f.path).join(", ");
    return (
      `Synthra has ${retrieval.confidence}-confidence context for "${query}" (top files: ${top}). ` +
      `Use mcp__synthra__graph_continue("${query}") instead of ${toolName}, ` +
      `or read a specific file/symbol with mcp__synthra__graph_read.`
    );
  }

  return `${header}\n${parts.join("\n")}\n${footer}`;
}

export async function handleGate(req: GateRequest, ctx: ServerContext): Promise<GateResponse> {
  if (!req?.tool_name || typeof req.tool_name !== "string") {
    return { decision: "allow", reason: "no tool_name" };
  }

  if (!BLOCKABLE_TOOLS.has(req.tool_name)) {
    return { decision: "allow" };
  }

  const input = (
    req.tool_input && typeof req.tool_input === "object" ? req.tool_input : {}
  ) as Record<string, unknown>;
  const query = extractQuery(req.tool_name, input);
  if (!query) {
    const res: GateResponse = { decision: "allow", reason: "no extractable query" };
    await logDecision(ctx, req.tool_name, null, res.decision, res.reason);
    return res;
  }

  // Guard 1 — the query targets markup/CSS/attributes/literals, which the graph
  // does not index. Blocking would only force a fallback, so let Grep through.
  if (req.tool_name === "Grep" && looksLikeNonSymbolQuery(query)) {
    const res: GateResponse = {
      decision: "allow",
      reason: `"${query}" targets markup/CSS/attributes, not code symbols — letting Grep through (the graph indexes symbols).`,
    };
    await logDecision(ctx, req.tool_name, query, res.decision, res.reason);
    return res;
  }

  const retrieval = await retrieve(ctx.graph, query);
  // "low" = no real matches → let Grep through; Synthra has nothing useful.
  // "medium" + "high" = Synthra has structured context for this query →
  // bias toward blocking. The pitch ("use graph_continue instead of Grep")
  // holds at medium too — on real codebases of any size, "high" is rare
  // because almost every query matches multiple files.
  if (retrieval.confidence === "low") {
    const res: GateResponse = {
      decision: "allow",
      reason: `confidence=low — no graph context for "${query}", letting ${req.tool_name} through`,
    };
    await logDecision(ctx, req.tool_name, query, res.decision, res.reason);
    return res;
  }

  // Medium / high — but check if recent activity overlaps the query first.
  // If the user just touched a file matching the query, static context may
  // be stale and they probably want a fresh search.
  const qTokens = new Set(tokenizeQuery(query));
  const recentPaths = ctx.activity.recentFilePaths(RECENT_ACTIVITY_WINDOW_MS);
  const overlap = recentlyTouchedMatchesQuery(recentPaths, qTokens, ctx.graph);

  if (overlap.length > 0) {
    const res: GateResponse = {
      decision: "allow",
      reason:
        `confidence=${retrieval.confidence} but human just touched ${overlap.slice(0, 3).join(", ")} — ` +
        `static context may be stale, letting ${req.tool_name} through.`,
    };
    await logDecision(ctx, req.tool_name, query, res.decision, res.reason);
    return res;
  }

  // Guard 2 — the graph matched files only by keyword/path, not by a symbol the
  // query names, so graph_read can't return a real slice. A block would just
  // force a fallback Read; let the search through instead.
  if (!retrieval.symbolMatched) {
    const res: GateResponse = {
      decision: "allow",
      reason:
        `confidence=${retrieval.confidence} but only keyword/path matched (no symbol the query names) — ` +
        `graph_read can't slice it, letting ${req.tool_name} through.`,
    };
    await logDecision(ctx, req.tool_name, query, res.decision, res.reason);
    return res;
  }

  const hint = buildBlockHint(query, retrieval, ctx.graph, req.tool_name);
  const res: GateResponse = { decision: "block", reason: hint };
  await logDecision(ctx, req.tool_name, query, res.decision, hint, hint.length);
  return res;
}
