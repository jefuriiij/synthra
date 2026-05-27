// POST /log — Stop hook posts token usage parsed from Claude's transcript JSONL.
// Appends to .synthra-graph/token_log.jsonl.
// TODO: M3

export interface LogEntry {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model: string;
  description?: string;
  project: string;
}

export async function handleLog(_entry: LogEntry): Promise<void> {
  throw new Error("Synthra: handleLog not yet implemented (M3)");
}
