// POST /gate — PreToolUse hook calls this with the tool name + arguments.
// THE MOAT — improvement #1. Strategy:
//   - For Grep/Glob: extract the search pattern, run retrieve().
//   - If recent human activity touches a file matching the query → ALLOW
//     even at high confidence (the user's head is in that file; static
//     context may be stale).
//   - If confidence === "high" and no recent overlap → BLOCK with a reason
//     pointing at graph_continue / graph_read.
//   - Otherwise → ALLOW.

import { retrieve } from "../../graph/retrieve.js";
import { tokenizeQuery } from "../../graph/rank.js";
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

function recentlyTouchedMatchesQuery(
  recentPaths: string[],
  queryTokens: Set<string>,
): string[] {
  const matches: string[] = [];
  for (const path of recentPaths) {
    const lower = path.toLowerCase();
    for (const t of queryTokens) {
      if (lower.includes(t)) {
        matches.push(path);
        break;
      }
    }
  }
  return matches;
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
  if (!query) return { decision: "allow", reason: "no extractable query" };

  const retrieval = await retrieve(ctx.graph, query);
  if (retrieval.confidence !== "high") {
    return {
      decision: "allow",
      reason: `confidence=${retrieval.confidence} — letting ${req.tool_name} through`,
    };
  }

  // High confidence — but check if recent activity overlaps the query first.
  const qTokens = new Set(tokenizeQuery(query));
  const recentPaths = ctx.activity.recentFilePaths(RECENT_ACTIVITY_WINDOW_MS);
  const overlap = recentlyTouchedMatchesQuery(recentPaths, qTokens);

  if (overlap.length > 0) {
    return {
      decision: "allow",
      reason:
        `confidence=high but human just touched ${overlap.slice(0, 3).join(", ")} — ` +
        `static context may be stale, letting ${req.tool_name} through.`,
    };
  }

  const top = retrieval.files.slice(0, 3).map((f) => f.path).join(", ");
  return {
    decision: "block",
    reason:
      `Synthra has high-confidence context for "${query}" (top files: ${top}). ` +
      `Use the \`graph_continue\` MCP tool with this query instead of ${req.tool_name}, ` +
      `or read a specific file/symbol with \`graph_read\`.`,
  };
}
