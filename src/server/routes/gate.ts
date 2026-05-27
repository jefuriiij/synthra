// POST /gate — PreToolUse hook calls this with the tool name + arguments.
// Returns { decision: "allow" | "block", reason? }.
// THE MOAT — improvement #1.
// Strategy:
//   - If tool is Grep/Glob AND the graph already has a high-confidence answer → block
//   - If recent activity touches files matching the query → allow (relax the block)
//   - Otherwise → allow
// TODO: M3 (basic block); M5 (activity-aware relaxation)

export interface GateRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface GateResponse {
  decision: "allow" | "block";
  reason?: string;
}

export async function handleGate(_req: GateRequest): Promise<GateResponse> {
  throw new Error("Synthra: handleGate not yet implemented (M3)");
}
