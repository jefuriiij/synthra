// Registers Synthra's MCP with Claude Code, installs hooks, spawns `claude`.
// Traps SIGINT so we can run cleanup after Claude exits.
// TODO: M3

import type { SynthraPaths } from "../shared/paths.js";

export interface StartClaudeOptions {
  paths: SynthraPaths;
  mcpPort: number;
  resumeSessionId?: string;
  initialPrompt?: string;
}

export async function startClaude(_opts: StartClaudeOptions): Promise<number> {
  throw new Error("Synthra: startClaude not yet implemented (M3)");
}
