// POST /gate — PreToolUse hook calls this with the tool name + arguments.
// THE MOAT — improvement #1. Strategy:
//   - For Grep/Glob: extract the search pattern, run retrieve().
//   - If recent human activity touches a file matching the query → ALLOW
//     even at high confidence (the user's head is in that file; static
//     context may be stale).
//   - If confidence === "high" and no recent overlap → BLOCK with a reason
//     pointing at graph_continue / graph_read.
//   - Otherwise → ALLOW.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { retrieve } from "../../graph/retrieve.js";
import { tokenizeQuery } from "../../graph/rank.js";
import type { GraphSchema } from "../../graph/types.js";
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

async function logDecision(
  ctx: ServerContext,
  toolName: string,
  query: string | null,
  decision: "allow" | "block",
  reason: string | undefined,
): Promise<void> {
  try {
    await mkdir(dirname(ctx.paths.gateLog), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      decision,
      query,
      reason,
    };
    await appendFile(ctx.paths.gateLog, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Durability is best-effort; an unwritable disk shouldn't fail the gate.
  }
}

export async function handleGate(req: GateRequest, ctx: ServerContext): Promise<GateResponse> {
  if (!req?.tool_name || typeof req.tool_name !== "string") {
    return { decision: "allow", reason: "no tool_name" };
  }

  if (!BLOCKABLE_TOOLS.has(req.tool_name)) {
    return { decision: "allow" };
  }

  const input = (req.tool_input && typeof req.tool_input === "object" ? req.tool_input : {}) as Record<string, unknown>;
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

  const top = retrieval.files.slice(0, 3).map((f) => f.path).join(", ");
  const res: GateResponse = {
    decision: "block",
    reason:
      `Synthra has ${retrieval.confidence}-confidence context for "${query}" (top files: ${top}). ` +
      `Use the \`graph_continue\` MCP tool with this query instead of ${req.tool_name}, ` +
      `or read a specific file/symbol with \`graph_read\`.`,
  };
  await logDecision(ctx, req.tool_name, query, res.decision, res.reason);
  return res;
}
