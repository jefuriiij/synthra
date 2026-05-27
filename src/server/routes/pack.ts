// POST /pack { query } → returns a ContextPack.
// Called by the packer-aware MCP tools.
// TODO: M2

import type { ContextPack } from "../../packer/index.js";

export interface PackRequest {
  query: string;
  maxTokens?: number;
}

export async function handlePack(_req: PackRequest): Promise<ContextPack> {
  throw new Error("Synthra: handlePack not yet implemented (M2)");
}
