// Idempotent patcher for the project's CLAUDE.md. Manages a single block
// bounded by <!-- synthra-policy v<N> BEGIN --> ... <!-- synthra-policy v<N> END -->.
// On each run, any prior synthra-policy block (any version) is removed and the
// current-version block is appended at the end.

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export const POLICY_VERSION = 7;
export const POLICY_BEGIN = `<!-- synthra-policy v${POLICY_VERSION} BEGIN -->`;
export const POLICY_END = `<!-- synthra-policy v${POLICY_VERSION} END -->`;

// Matches a synthra-policy block of any version, e.g. v1, v2 …
const ANY_BLOCK_RE =
  /<!--\s*synthra-policy\s+v\d+\s+BEGIN\s*-->[\s\S]*?<!--\s*synthra-policy\s+v\d+\s+END\s*-->\s*/g;

export interface PatchResult {
  created: boolean;
  updated: boolean;
  skipped: boolean;
}

export function policyBlock(): string {
  return [
    POLICY_BEGIN,
    "## Synthra context policy",
    "",
    "Synthra has pre-loaded structured context into this session and exposes",
    "the project's code graph through MCP tools. **Prefer these tools over",
    "Grep / Glob / Read** — they are faster, cheaper, and already filtered",
    "to relevant files.",
    "",
    "> **Tool namespace.** Synthra's MCP tools are exposed as",
    "> `mcp__synthra__graph_continue`, `mcp__synthra__graph_read`, and",
    "> `mcp__synthra__graph_register_edit`. **Short names will NOT resolve**",
    "> in ToolSearch or invocation — always use the full namespaced form.",
    "> If the tools are deferred, load their schemas with ToolSearch:",
    "> `select:mcp__synthra__graph_continue,mcp__synthra__graph_read,mcp__synthra__graph_register_edit`.",
    "> Below, short names (`graph_continue` etc.) appear in prose for",
    "> readability only.",
    "",
    "### Tools",
    "",
    "- **`graph_continue(query)`** — returns a `Confidence` label, the list",
    "  of relevant `Files`, and signatures + top function bodies for those",
    "  files. Your default first move when you need project context.",
    "- **`graph_read(target)`** — fetch source. Prefer the",
    '  `"file/path.ts::SymbolName"` form over a bare file path — reading one',
    "  symbol is ~50 tokens, reading a whole file is thousands.",
    "- **`graph_register_edit(files)`** — after you edit files, call this so",
    "  subsequent turns weight your changes and avoid stale snapshots.",
    "",
    "### When to call `graph_continue` — and when to skip",
    "",
    "**Call `graph_continue` only when you do NOT already know the relevant",
    "files.**",
    "",
    "Call it when:",
    "- This is the first message of a new task or conversation",
    "- The task shifts to a different area of the codebase",
    "- You need files you haven't seen yet in this session",
    "",
    "**Skip `graph_continue` when:**",
    "- You already identified the relevant files earlier in this conversation",
    "- You are doing follow-up work on files already read (verify, refactor,",
    "  test, docs, cleanup, commit)",
    "- The task is pure text (commit message, explanation, summary)",
    "",
    "If skipping, go directly to",
    '`mcp__synthra__graph_read("file.ts::symbol")` on what you already know.',
    "",
    "### Confidence caps",
    "",
    "When `graph_continue` returns:",
    "",
    "- **`Confidence: high`** → Stop. Do NOT Grep, Glob, or further explore",
    "  for this query. The graph already has it.",
    "- **`Confidence: medium`** → Read the listed `Files` directly via",
    '  `mcp__synthra__graph_read("file::symbol")` *before* trying Grep. The',
    "  graph has narrowed the search space — use it, don't bypass it.",
    "- **`Confidence: low`** → You may use Grep / Glob, but the PreToolUse",
    "  hook may still block redundant calls.",
    "",
    "### Reading code",
    "",
    "- **Always use `file::symbol` notation** with `graph_read`. Whole-file",
    "  reads should be rare — only when you genuinely need the full file.",
    "- If `graph_continue`'s `Files` list contains a `::` entry, pass it",
    "  verbatim to `graph_read`.",
    "- **Large file?** Don't read it in successive line-range chunks — call",
    "  `mcp__synthra__graph_continue` or",
    '  `mcp__synthra__graph_read("file::symbol")` to pull the one symbol you',
    "  need. Chunked whole-file Reads are exactly the cost `graph_read`",
    "  exists to avoid.",
    "",
    "### Editing a file",
    "",
    "Claude Code's `Edit` tool (and `Write` when overwriting) only accepts a",
    "file that was opened with the **`Read` tool** — a `graph_read` slice does",
    'not count, and editing such a file fails with *"File has not been read',
    'yet."* So before editing a file you only know through `graph_read`: take',
    "the line range from its header (e.g. `…::handler (L120-168)`), `Read` that",
    "file with a matching `offset`/`limit`, then `Edit`. That satisfies the",
    "gate while keeping the read small — don't whole-file `Read` unless the",
    "edit spans most of the file.",
    "",
    "### Don'ts",
    "",
    "- Don't Grep / Glob before calling `graph_continue` when required — the",
    "  PreToolUse hook may block it.",
    "- Don't call `graph_continue` more than once per turn.",
    "- Don't read whole files when a symbol-level read would suffice.",
    "",
    "### Resuming a session",
    "",
    'At session start the primer may begin with a **"Since you were last here"**',
    "digest — recent commits, files touched, open next-steps, and recent",
    "decisions carried over from the previous session. **Trust it.** It is the",
    "cheapest possible orientation: do NOT re-run `graph_continue` or Grep just",
    'to rediscover "what were we doing / what changed" — that work is already',
    "done. For the concrete next steps,",
    '`mcp__synthra__context_recall({kind:"next"})` returns them verbatim. Only',
    "reach for fresh retrieval when the task moves beyond what the digest",
    "covers.",
    "",
    "### Session-end resume note",
    "",
    'When the user signals they\'re done (e.g. "bye", "wrap up", "done"),',
    "persist the resume state by calling `context_remember` once per bullet.",
    "Synthra re-renders `.synthra/CONTEXT.md` from those entries at session",
    "end — do **NOT** write to `CONTEXT.md` directly, it is a derived view",
    "and direct edits are overwritten by the Stop hook.",
    "",
    "Use these `kind` values:",
    "",
    '- **`kind: "task"`** — what is being worked on right now (1 entry)',
    '- **`kind: "decision"`** — non-obvious choices made this session (max 3)',
    '- **`kind: "next"`** — concrete next steps (max 3)',
    "",
    'Tag entries with the relevant area (`tags: ["auth"]`) and the files',
    'they touch (`files: ["src/auth.ts"]`) so later `context_recall` queries',
    "can filter. Keep each `text` to 1–2 sentences.",
    "",
    "_This block is managed by Synthra. Edits inside the BEGIN/END markers",
    "are overwritten on every `syn .` run._",
    "",
    POLICY_END,
  ].join("\n");
}

// A lean, agent-facing onboarding skeleton written ONLY when a project has no
// CLAUDE.md yet. It captures the durable "why/how" the graph can't infer
// (build/test, conventions, decisions, gotchas). It lives OUTSIDE the
// synthra-policy markers, so later `syn .` runs — which strip and re-add the
// policy block — never touch what the user fills in here.
export function onboardingSkeleton(projectName: string): string {
  return [
    `# ${projectName}`,
    "",
    "> Onboarding notes for AI coding agents. Synthra's graph already knows the",
    "> code's *structure* (files, symbols, imports) — this file is for what the",
    "> graph can't infer: how to run the project, its conventions, and the",
    "> decisions behind them. Keep it lean and current; delete prompts you don't need.",
    "",
    "## Build & test",
    "",
    "- TODO: install deps / build",
    "- TODO: run tests / lint / typecheck",
    "- TODO: run the app locally",
    "",
    "## Conventions",
    "",
    "- TODO: code style, naming, file layout the agent should follow",
    "",
    "## Key decisions",
    "",
    '- TODO: non-obvious choices and *why* ("we use X not Y because …")',
    "",
    "## Gotchas",
    "",
    '- TODO: traps, footguns, "don\'t touch X without Y"',
    "",
    "_Tip: run `/init` in Claude Code to auto-draft the sections above, then trim",
    "to the durable bits. Synthra manages its own block below — leave it._",
    "",
  ].join("\n");
}

export async function patchClaudeMd(path: string, projectName?: string): Promise<PatchResult> {
  let existing: string | null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = null;
  }

  const block = policyBlock();

  if (existing === null) {
    // First creation: scaffold the onboarding skeleton (user-owned, written
    // once) followed by Synthra's managed policy block.
    const name = projectName || basename(dirname(path)) || "this project";
    await writeFile(path, onboardingSkeleton(name) + "\n" + block + "\n", "utf8");
    return { created: true, updated: false, skipped: false };
  }

  // Strip any prior policy block (any version), then re-append the current one.
  // The block is always separated from the preceding content by exactly one
  // blank line. We must normalize here: ANY_BLOCK_RE's trailing `\s*` consumes
  // the block's own newline, so naively re-joining `stripped + "\n" + block`
  // would add a blank line on every run — invisible per `syn .`, but with
  // auto-reindex it rewrites the watched CLAUDE.md endlessly. Trimming trailing
  // whitespace and re-joining with a fixed gap makes the patch idempotent.
  const stripped = existing.replace(ANY_BLOCK_RE, "");
  const base = stripped.replace(/\s+$/, "");
  const desired = base.length ? `${base}\n\n${block}\n` : `${block}\n`;

  if (desired === existing) {
    return { created: false, updated: false, skipped: true };
  }

  await writeFile(path, desired, "utf8");
  return { created: false, updated: true, skipped: false };
}
