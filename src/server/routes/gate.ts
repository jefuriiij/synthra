// POST /gate — PreToolUse hook calls this with the tool name + arguments.
// THE MOAT — improvement #1. In M2 we return allow-all so the server boots
// without affecting AI behavior; M3 wires the real block strategy:
//   - If tool is Grep/Glob AND retrieve() returns confidence === "high" → block
//   - If recent activity touches files matching the query → allow
//   - Otherwise → allow

import type { ServerContext } from "../context.js";

export interface GateRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface GateResponse {
  decision: "allow" | "block";
  reason?: string;
}

export async function handleGate(_req: GateRequest, _ctx: ServerContext): Promise<GateResponse> {
  return { decision: "allow", reason: "M2 stub: gate logic wired in M3" };
}
