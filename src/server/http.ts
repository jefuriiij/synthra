// HTTP server (Hono). Hosts the MCP endpoint and Synthra's own routes
// (/prime, /pack, /log, /gate, /activity, /context-update).
// Listens on a free port in 8080–8099. Writes the chosen port to mcp_port.
// TODO: M2 (core routes); M3 (gate)

import type { SynthraPaths } from "../shared/paths.js";

export interface ServerHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export async function startServer(_paths: SynthraPaths): Promise<ServerHandle> {
  throw new Error("Synthra: startServer not yet implemented (M2)");
}
