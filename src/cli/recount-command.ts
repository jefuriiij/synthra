// `syn recount` (v0.50): rebuild a project's token log from the transcripts
// Claude Code still keeps (30 days by default).
//
// Why: Claude Code writes one reply on several transcript lines, one per
// content block, each with the same message id and the same usage. Until
// v0.50 the Stop hooks added up every line, so the log holds each reply two
// to three times (measured on a real session: $1,170.82 logged, $476.06 real).
// The hooks count right from v0.50 on; this fixes what is already logged.
//
// What it does: reads every transcript of the project, counts each reply once
// (also across files: a fork or a resume copies earlier lines), and replaces
// the Claude entries in token_log.jsonl from the first transcript line on.
// Older entries and Codex entries stay as they are. The old log is kept
// beside it as a backup, and the Stop hook's offsets move to the end of each
// transcript so nothing is logged a second time.

import { createReadStream } from "node:fs";
import { copyFile, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { sumSubagentUsage } from "../server/routes/subagent-usage.js";
import { updateJsonFile, writeTextAtomic } from "../shared/json-store.js";
import { type SynthraPaths, resolvePaths, sameRoot } from "../shared/paths.js";
import { estimateCostUsd } from "../shared/pricing.js";
import { promptYesNo } from "./self-update.js";

/** One line of token_log.jsonl, as far as the recount needs it. */
interface LogLine {
  ts?: string;
  written_at?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_1h_input_tokens?: number;
  model?: string;
  description?: string;
  project?: string;
  read_calls?: number;
  agent?: string;
  subagent?: string;
  recount?: true;
}

export interface RecountPlan {
  /** Transcript files read. */
  transcripts: number;
  /** Replies counted (main sessions and subagents). */
  replies: number;
  /** The first transcript line with usage: entries from here on are replaced. */
  since: string | null;
  /** The rebuilt entries, oldest first. */
  entries: LogLine[];
  /** Cost of the entries the log holds now, from `since` on (Codex left out). */
  costBefore: number;
  costAfter: number;
  /** The whole new log. */
  nextLog: LogLine[];
  /** Per transcript: how many full lines it has now. */
  offsets: { file: string; lines: number }[];
  /** Per subagent file: its size to the last full line, and its last reply. */
  marks: { file: string; offset: number; last?: string }[];
}

const AGENT_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/;
const fold = (s: string) => (process.platform === "linux" ? s : s.toLowerCase());

/** Claude Code's folder for a project's transcripts: every character of the
 *  path that is not a letter or a digit becomes "-". */
export async function transcriptDirs(root: string, home: string = homedir()): Promise<string[]> {
  const base = join(home, ".claude", "projects");
  const slug = fold(resolve(root).replace(/[^A-Za-z0-9]/g, "-"));
  const names = await readdir(base).catch(() => [] as string[]);
  return names.filter((n) => fold(n) === slug).map((n) => join(base, n));
}

const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
const timeOf = (e: LogLine) => Date.parse(e.ts ?? e.written_at ?? "");

interface Line {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    id?: unknown;
    model?: unknown;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

/** A line the user typed (not a tool result, not a note Claude Code adds). */
function isPrompt(e: Line): boolean {
  if (e.type !== "user" || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && c.some((b) => (b as { type?: string })?.type === "text");
}

/** Whether the file ends with a newline (its last line is complete). */
async function endsWithNewline(file: string): Promise<boolean> {
  const size = (await stat(file)).size;
  if (size === 0) return true;
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

/**
 * One transcript, as one entry per turn (what the Stop hook logs), each reply
 * counted once. `counted` holds the reply ids other files already gave and
 * gets this file's. Returns null when the transcript belongs to another
 * folder (two paths can share a transcript folder name).
 */
async function readTranscript(
  file: string,
  root: string,
  counted: Set<string>,
): Promise<{ entries: LogLine[]; replies: number; lines: number } | null> {
  const entries: LogLine[] = [];
  const mine = new Set<string>();
  const blank = (): LogLine & { reads: number } => ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    model: "",
    reads: 0,
  });
  let turn = blank();
  let lines = 0;
  let checkedFolder = false;
  const flush = () => {
    if (turn.input_tokens + turn.output_tokens > 0) {
      const { reads, ...rest } = turn;
      entries.push({
        ...rest,
        description: "synthra-recount",
        project: root,
        read_calls: reads,
        recount: true,
      });
    }
    turn = blank();
  };
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const raw of rl) {
    lines++;
    if (!raw.trim()) continue;
    let e: Line;
    try {
      e = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (!checkedFolder && typeof e.cwd === "string") {
      checkedFolder = true;
      if (!sameRoot(e.cwd, root)) {
        rl.close();
        return null;
      }
    }
    if (isPrompt(e)) flush();
    const m = e.message;
    if (!m || typeof m !== "object") continue;
    const id = typeof m.id === "string" ? m.id : "";
    // Counted from another file: a fork or a resume copied this line.
    if (id && counted.has(id)) continue;
    if (Array.isArray(m.content)) {
      for (const b of m.content as { type?: string; name?: string }[]) {
        if (b?.type === "tool_use" && b.name === "Read") turn.reads++;
      }
    }
    const u = m.usage;
    if (!u || typeof u !== "object") continue;
    if (id) {
      if (mine.has(id)) continue;
      mine.add(id);
    }
    turn.input_tokens += num(u.input_tokens);
    turn.output_tokens += num(u.output_tokens);
    turn.cache_creation_input_tokens =
      (turn.cache_creation_input_tokens ?? 0) + num(u.cache_creation_input_tokens);
    turn.cache_read_input_tokens =
      (turn.cache_read_input_tokens ?? 0) + num(u.cache_read_input_tokens);
    turn.cache_creation_1h_input_tokens =
      (turn.cache_creation_1h_input_tokens ?? 0) +
      num((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens);
    if (typeof m.model === "string" && m.model) turn.model = m.model;
    if (typeof e.timestamp === "string") turn.written_at = e.timestamp;
  }
  flush();
  for (const id of mine) counted.add(id);
  // A last line with no newline yet is one Claude Code is still writing.
  const full = (await endsWithNewline(file)) ? lines : Math.max(0, lines - 1);
  return { entries, replies: mine.size, lines: full };
}

/** Work out the recount for a project. Reads only; changes nothing. */
export async function planRecount(
  paths: SynthraPaths,
  { home = homedir() }: { home?: string } = {},
): Promise<RecountPlan> {
  const root = paths.projectRoot;
  const counted = new Set<string>();
  const entries: LogLine[] = [];
  const offsets: RecountPlan["offsets"] = [];
  const marks: RecountPlan["marks"] = [];
  let transcripts = 0;
  let replies = 0;

  for (const dir of await transcriptDirs(root, home)) {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    // Oldest first, so a copied reply is counted in the session it was made in.
    const files = await Promise.all(
      names.map(async (n) => ({
        file: join(dir, n),
        at: await stat(join(dir, n)).then(
          (s) => s.birthtimeMs || s.mtimeMs,
          () => 0,
        ),
      })),
    );
    files.sort((a, b) => a.at - b.at);
    for (const { file } of files) {
      const got = await readTranscript(file, root, counted).catch(() => null);
      if (!got) continue;
      transcripts++;
      replies += got.replies;
      entries.push(...got.entries);
      offsets.push({ file, lines: got.lines });

      // The session's subagents, each in a file of its own.
      const subDir = join(dir, basename(file, ".jsonl"), "subagents");
      const subs = (await readdir(subDir).catch(() => [] as string[]))
        .filter((n) => AGENT_FILE.test(n))
        .sort();
      for (const name of subs) {
        const subFile = join(subDir, name);
        const buf = await readFile(subFile).catch(() => null);
        if (!buf) continue;
        const end = buf.lastIndexOf(0x0a) + 1;
        if (end === 0) continue;
        const before = counted.size;
        const at = await stat(subFile).then(
          (s) => s.mtime.toISOString(),
          () => new Date().toISOString(),
        );
        const agent = name.slice("agent-".length, -".jsonl".length);
        for (const u of sumSubagentUsage(buf.subarray(0, end).toString("utf8"), agent, counted)) {
          entries.push({
            ...u,
            description: "synthra-subagent",
            project: root,
            written_at: at,
            recount: true,
          });
        }
        replies += counted.size - before;
        const last = [...counted].pop();
        marks.push({ file: subFile, offset: end, ...(last ? { last } : {}) });
      }
    }
  }

  const times = entries.map(timeOf).filter((t) => Number.isFinite(t));
  const sinceMs = times.length ? Math.min(...times) : Number.NaN;
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null;

  const old: LogLine[] = [];
  for (const raw of (await readFile(paths.tokenLog, "utf8").catch(() => "")).split("\n")) {
    if (!raw.trim()) continue;
    try {
      old.push(JSON.parse(raw) as LogLine);
    } catch {
      // a torn line: dropped, as the dashboard drops it
    }
  }
  // Replaced: Claude's entries from the first transcript line on. Kept: what
  // is older (no transcript left to count from), and what Codex logged.
  const replaced = (e: LogLine) => {
    if (since === null || e.agent === "codex") return false;
    const t = timeOf(e);
    return Number.isFinite(t) && t >= sinceMs;
  };
  const kept = old.filter((e) => !replaced(e));
  const cost = (list: LogLine[]) =>
    list.reduce((sum, e) => sum + estimateCostUsd({ ...e, model: e.model ?? "" }), 0);
  const nextLog = [...kept, ...entries]
    .map((e, i) => ({ e, i, t: timeOf(e) }))
    .sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) ? a.t - b.t : 0) || a.i - b.i)
    .map((x) => x.e);

  return {
    transcripts,
    replies,
    since,
    entries,
    costBefore: cost(old.filter(replaced)),
    costAfter: cost(entries),
    nextLog,
    offsets,
    marks,
  };
}

/** Write a plan: the backup, the new log, and the hooks' offsets. Returns the
 *  backup's path (null when there was no log yet). */
export async function applyRecount(
  paths: SynthraPaths,
  plan: RecountPlan,
  now: Date = new Date(),
): Promise<string | null> {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backup = `${paths.tokenLog}.before-recount-${stamp}`;
  const had = await copyFile(paths.tokenLog, backup).then(
    () => true,
    () => false,
  );
  const text = plan.nextLog.map((e) => `${JSON.stringify(e)}\n`).join("");
  await writeTextAtomic(paths.tokenLog, text);

  // The Stop hook reads a transcript from this line on: everything before it
  // is in the log now.
  for (const o of plan.offsets) {
    await writeFile(`${o.file}.stopoffset`, String(o.lines), "ascii").catch(() => undefined);
  }
  if (plan.marks.length > 0) {
    const at = now.toISOString();
    await updateJsonFile<Record<string, { offset: number; at: string; last?: string }>>(
      join(paths.graphDir, "subagent_offsets.json"),
      () => ({}),
      (current) => {
        const next = { ...current };
        for (const m of plan.marks) {
          next[m.file] = { offset: m.offset, at, ...(m.last ? { last: m.last } : {}) };
        }
        return next;
      },
    ).catch(() => undefined);
  }
  return had ? backup : null;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function recountCommand(rawPath: string, opts: { yes?: boolean } = {}): Promise<void> {
  const paths = resolvePaths(resolve(rawPath));
  const name = basename(paths.projectRoot);
  console.log(`Reading Claude Code's transcripts for ${name}...`);
  const plan = await planRecount(paths);
  if (plan.transcripts === 0 || plan.since === null) {
    console.log(
      `No transcripts with usage found for ${paths.projectRoot}. Claude Code keeps them for 30 days by default; there is nothing to recount.`,
    );
    return;
  }
  console.log("");
  console.log(`Recount for ${name}`);
  console.log(`  Transcripts read:        ${plan.transcripts}`);
  console.log(`  Replies counted once:    ${plan.replies.toLocaleString("en-US")}`);
  console.log(`  From:                    ${plan.since.slice(0, 10)}`);
  console.log(`  In the log now:          ${usd(plan.costBefore)}`);
  console.log(`  After the recount:       ${usd(plan.costAfter)}`);
  console.log("");
  console.log(
    "Entries older than that date stay as they are (their transcripts are gone). The old log is kept as a backup.",
  );
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.log("Run it again with --yes to replace the log.");
      return;
    }
    if (!(await promptYesNo("Replace the token log with the recount? [y/N] "))) {
      console.log("Nothing changed.");
      return;
    }
  }
  const backup = await applyRecount(paths, plan);
  console.log(backup ? `Done. Backup: ${backup}` : "Done.");
}
