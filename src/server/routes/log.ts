// POST /log — Stop hook posts per-turn token usage parsed from Claude's
// transcript JSONL. Synthra appends each entry as one line to token_log.jsonl.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { ServerContext } from "../context.js";

export interface LogEntry {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model: string;
  description?: string;
  project: string;
}

export interface LogResponse {
  ok: true;
  written_at: string;
}

export async function handleLog(entry: LogEntry, ctx: ServerContext): Promise<LogResponse> {
  if (!entry || typeof entry.input_tokens !== "number" || typeof entry.output_tokens !== "number") {
    throw new Error("log: input_tokens and output_tokens (number) are required");
  }

  const written_at = new Date().toISOString();
  const record = { ...entry, written_at };
  await mkdir(dirname(ctx.paths.tokenLog), { recursive: true });
  await appendFile(ctx.paths.tokenLog, JSON.stringify(record) + "\n", "utf8");

  return { ok: true, written_at };
}
