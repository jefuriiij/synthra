// GET /prime — SessionStart and PreCompact hooks call this. Returns the priming
// text Claude sees at session start.
//
// When the previous session left a snapshot (.synthra-graph/session.json), the
// primer leads with a budget-bounded "Since you were last here" digest — recent
// commits, files touched, open next-steps, recent decisions — so a fresh session
// arrives oriented instead of re-paying tokens to rediscover recent work. With
// no snapshot (first session, or none survived), it falls back to the legacy
// graph-counts primer verbatim.

import { currentBranch } from "../../memory/branches.js";
import { readSession, type SessionState } from "../../memory/session.js";
import type { ServerContext } from "../context.js";

export interface PrimeResponse {
  primer: string;
  port: number;
}

// ~680 tokens. The digest rides the SessionStart primer channel, separate from
// the graph pack's own ~4000-token budget — they don't compete.
const RESUME_PRIMER_MAX_CHARS = 2720;

const MAX_FILES = 15;
const MAX_COMMITS = 5;
const MAX_BULLETS = 3;

function legacyPrimer(ctx: ServerContext): string {
  const g = ctx.graph;
  return (
    `Synthra context loaded for ${g.root}.\n` +
    `${g.file_count} files indexed, ${g.symbol_count} symbols. ` +
    `Prefer the graph_* MCP tools over Grep/Glob for navigation.`
  );
}

function hasContent(snap: SessionState): boolean {
  return Boolean(
    snap.recentCommits.length ||
      snap.filesTouched.length ||
      snap.summary.tasks.length ||
      snap.summary.next.length ||
      snap.summary.decisions.length,
  );
}

function buildResumeDigest(snap: SessionState, branchNow: string): string {
  const plural = (n: number) => (n === 1 ? "" : "s");
  const head =
    `## Since you were last here — ${snap.branch}  ` +
    `(${snap.recentCommits.length} commit${plural(snap.recentCommits.length)}, ` +
    `${snap.filesTouched.length} file${plural(snap.filesTouched.length)} touched)`;

  // Essential, high-signal block — never dropped under the budget.
  const essential: string[] = [head];
  if (snap.branch !== branchNow) {
    essential.push("");
    essential.push(
      `_(snapshot was for branch '${snap.branch}'; you're now on '${branchNow}' — may be stale)_`,
    );
  }
  if (snap.summary.tasks[0]) {
    essential.push("", "### In progress", `- ${snap.summary.tasks[0]}`);
  }
  if (snap.summary.next.length) {
    essential.push("", "### Open next steps");
    for (const n of snap.summary.next.slice(0, MAX_BULLETS)) essential.push(`- ${n}`);
  }
  if (snap.summary.decisions.length) {
    essential.push("", "### Recent decisions");
    for (const d of snap.summary.decisions.slice(0, MAX_BULLETS)) essential.push(`- ${d}`);
  }

  // Supporting context — appended only while budget remains, so commits/files
  // are what get dropped first if we're over the cap.
  const extra: string[] = [];
  if (snap.recentCommits.length) {
    extra.push("", "### Recent commits");
    for (const c of snap.recentCommits.slice(0, MAX_COMMITS)) {
      const date = c.date ? ` (${c.date.slice(0, 10)})` : "";
      extra.push(`- \`${c.hash}\` ${c.message}${date}`);
    }
  }
  if (snap.filesTouched.length) {
    const shown = snap.filesTouched.slice(0, MAX_FILES);
    const more = snap.filesTouched.length - shown.length;
    extra.push("", "### Files touched", shown.join(", ") + (more > 0 ? `, +${more} more` : ""));
  }

  let out = essential.join("\n");
  for (const line of extra) {
    if ((out + "\n" + line).length > RESUME_PRIMER_MAX_CHARS) break;
    out += "\n" + line;
  }
  return (
    out.length > RESUME_PRIMER_MAX_CHARS ? out.slice(0, RESUME_PRIMER_MAX_CHARS) : out
  ).trimEnd();
}

export async function handlePrime(ctx: ServerContext, port: number): Promise<PrimeResponse> {
  const legacy = legacyPrimer(ctx);

  const snap = await readSession(ctx.paths.sessionState);
  if (!snap || !hasContent(snap)) {
    return { primer: legacy, port };
  }

  const branchNow = await currentBranch(ctx.paths.projectRoot);
  const digest = buildResumeDigest(snap, branchNow);
  return { primer: `${digest}\n\n---\n\n${legacy}`, port };
}
