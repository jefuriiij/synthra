// MCP-over-HTTP protocol handler. Exposes Synthra's graph tools to Claude.
// Tools: graph_continue, graph_read, graph_register_edit, recent_activity.
// TODO: M2 (graph_*); M5 (recent_activity)

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handleToolCall(_call: McpToolCall): Promise<McpToolResult> {
  throw new Error("Synthra: handleToolCall not yet implemented (M2)");
}

export function listTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  // TODO: M2 — return real tool schemas
  return [];
}
