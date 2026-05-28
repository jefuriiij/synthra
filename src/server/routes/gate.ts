// POST /gate — PreToolUse hook calls this with the tool name + arguments.
// THE MOAT — improvement #1. Strategy:
//   - For Grep/Glob: extract the search pattern, run retrieve(); if confidence
//     is "high", block with a reason naming the graph_continue tool.
//   - For everything else: allow.
//
// Activity-aware relaxation (block override when human just touched the
// query's files) is layered in during M5.

import { retrieve } from "../../graph/retrieve.js";
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

function extractQuery(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const query = typeof input.query === "string" ? input.query : "";
    return (pattern || query).trim() || null;
  }
  if (toolName === "Glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    // For Glob we strip wildcard chars and path separators to recover a usable
    // query — e.g. "**/auth*.ts" → "auth ts".
    return pattern.replace(/[*?/\\.]+/g, " ").trim() || null;
  }
  return null;
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

  const top = retrieval.files.slice(0, 3).map((f) => f.path).join(", ");
  return {
    decision: "block",
    reason:
      `Synthra has high-confidence context for "${query}" (top files: ${top}). ` +
      `Use the \`graph_continue\` MCP tool with this query instead of ${req.tool_name}, ` +
      `or read a specific file/symbol with \`graph_read\`.`,
  };
}
