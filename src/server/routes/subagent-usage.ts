// What subagents cost (v0.46, Radar R-038). Claude Code keeps each subagent's
// turns in `<transcript dir>/<session id>/subagents/agent-<id>.jsonl`, not in
// the main transcript the Stop hook reads, so the dashboard missed them:
// measured on a real machine over 30 days, 5.4% of the cost ($810 of $15,131).
//
// The Stop hook sends its transcript path with /log; this reads the session's
// subagent files from where it stopped last time (a byte offset per file in
// .synthra-graph/subagent_offsets.json) and logs one token entry per file and
// model, marked `subagent`, so it counts as cost but never as a reply.
// Before Claude Code 2.1.307, streamed subagent replies recorded placeholder
// usage; those older numbers can be off.

import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { readJsonFile, updateJsonFile } from "../../shared/json-store.js";
import type { ServerContext } from "../context.js";

/** Files kept in the offsets record; older ones drop off. */
const KEEP_FILES = 500;
/** The most of one subagent file a single Stop reads. */
const MAX_READ_BYTES = 32 * 1024 * 1024;
const AGENT_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/;

interface Mark {
  offset: number;
  at: string;
}
type Marks = Record<string, Mark>;

export interface SubagentUsage {
  /** The agent id from the file name (`agent-<id>.jsonl`). */
  subagent: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_1h_input_tokens: number;
}

/** The usage in one stretch of a subagent file, per model. Lines that don't
 *  parse are skipped, not fatal. */
export function sumSubagentUsage(text: string, subagent: string): SubagentUsage[] {
  const byModel = new Map<string, SubagentUsage>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { message?: { model?: unknown; usage?: Record<string, unknown> } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const u = e?.message?.usage;
    if (!u || typeof u !== "object") continue;
    const model = typeof e.message?.model === "string" ? e.message.model : "";
    const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    const one =
      byModel.get(model) ??
      ({
        subagent,
        model,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_1h_input_tokens: 0,
      } satisfies SubagentUsage);
    one.input_tokens += n(u.input_tokens);
    one.output_tokens += n(u.output_tokens);
    one.cache_creation_input_tokens += n(u.cache_creation_input_tokens);
    one.cache_read_input_tokens += n(u.cache_read_input_tokens);
    one.cache_creation_1h_input_tokens += n(
      (u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens,
    );
    byModel.set(model, one);
  }
  return [...byModel.values()].filter((x) => x.input_tokens + x.output_tokens > 0);
}

/** The bytes after `offset`, up to the last full line. */
async function readNew(file: string, offset: number): Promise<{ text: string; end: number }> {
  const size = (await stat(file)).size;
  const from = offset <= size ? offset : 0;
  const length = Math.min(size - from, MAX_READ_BYTES);
  if (length <= 0) return { text: "", end: from };
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, from);
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return { text: "", end: from };
    return { text: buf.subarray(0, last + 1).toString("utf8"), end: from + last + 1 };
  } finally {
    await fh.close();
  }
}

/** The subagent usage since the last Stop of this session, each file read
 *  once (the first Stop to claim a stretch logs it). Never throws. */
export async function newSubagentUsage(
  ctx: ServerContext,
  transcriptPath: unknown,
): Promise<SubagentUsage[]> {
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath)) return [];
  if (!transcriptPath.endsWith(".jsonl")) return [];
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => AGENT_FILE.test(n)).sort();
  } catch {
    return [];
  }
  if (names.length === 0) return [];
  const marksFile = join(ctx.paths.graphDir, "subagent_offsets.json");
  const read = await readJsonFile<Marks>(marksFile);
  const marks: Marks = read.status === "ok" && read.data ? read.data : {};
  const out: SubagentUsage[] = [];
  const claims: Record<string, { from: number; to: number }> = {};
  for (const name of names) {
    const file = join(dir, name);
    const from = marks[file]?.offset ?? 0;
    const size = await stat(file).then(
      (s) => s.size,
      () => -1,
    );
    if (size < 0 || size === from) continue;
    const got = await readNew(file, from).catch(() => null);
    if (!got || got.end === from) continue;
    claims[file] = { from, to: got.end };
    out.push(...sumSubagentUsage(got.text, name.slice("agent-".length, -".jsonl".length)));
  }
  if (Object.keys(claims).length === 0) return [];
  // Only the first Stop to move a file's offset logs that stretch.
  const claimed = await updateJsonFile<Marks>(
    marksFile,
    () => ({}),
    (current) => {
      for (const [file, c] of Object.entries(claims)) {
        if ((current[file]?.offset ?? 0) !== c.from) return null;
      }
      const now = new Date().toISOString();
      const next: Marks = { ...current };
      for (const [file, c] of Object.entries(claims)) next[file] = { offset: c.to, at: now };
      const files = Object.keys(next).sort((a, b) =>
        (next[b]?.at ?? "").localeCompare(next[a]?.at ?? ""),
      );
      for (const f of files.slice(KEEP_FILES)) delete next[f];
      return next;
    },
  ).catch(() => null);
  return claimed?.status === "written" ? out : [];
}
