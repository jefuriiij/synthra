// POST /log — Stop hook posts per-turn token usage parsed from Claude's
// transcript JSONL. Synthra appends each entry as one line to token_log.jsonl.
// Since v0.20 the same payload may carry `delegations` — Task/Agent tool_use
// events the hook spotted in the transcript — which land in
// delegation_log.jsonl and power the dashboard's Dispatcher follow-rate.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { ServerContext } from "../context.js";

/** One subagent dispatch the Stop hook found in the transcript. */
export interface DelegationEvent {
  /** Transcript entry timestamp (ISO). */
  ts: string;
  /** subagent_type of the Task/Agent call, when present. */
  agent?: string | null;
  /** model override of the Task/Agent call, when present. */
  model?: string | null;
  /** Transcript filename minus .jsonl — anchors events to a session. */
  session_id?: string;
}

export interface LogEntry {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model: string;
  description?: string;
  project: string;
  /** v0.20+: delegation events observed since the last Stop (may be absent). */
  delegations?: DelegationEvent[];
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
  const { delegations, ...tokenEntry } = entry;
  await mkdir(dirname(ctx.paths.tokenLog), { recursive: true });

  // PowerShell 5.1's ConvertTo-Json collapses a single-element array into a
  // bare object — normalize before use.
  const events: DelegationEvent[] = Array.isArray(delegations)
    ? delegations
    : delegations
      ? [delegations as unknown as DelegationEvent]
      : [];

  // A delegations-only post (zero tokens) shouldn't pollute the token log.
  if (entry.input_tokens > 0 || entry.output_tokens > 0) {
    const record = { ...tokenEntry, written_at };
    await appendFile(ctx.paths.tokenLog, JSON.stringify(record) + "\n", "utf8");
  }

  if (events.length > 0) {
    const lines = events
      .filter((d) => d && typeof d.ts === "string" && d.ts.length > 0)
      .map((d) => JSON.stringify({ ...d, written_at }) + "\n")
      .join("");
    if (lines) await appendFile(ctx.paths.delegationLog, lines, "utf8");
  }

  return { ok: true, written_at };
}
