// Idempotent patcher for the project's CLAUDE.md. Manages a single block
// bounded by <!-- synthra-policy v<N> BEGIN --> ... <!-- synthra-policy v<N> END -->.
// On each run, any prior synthra-policy block (any version) is removed and the
// current-version block is appended at the end.

import { readFile, writeFile } from "node:fs/promises";

export const POLICY_VERSION = 2;
export const POLICY_BEGIN = `<!-- synthra-policy v${POLICY_VERSION} BEGIN -->`;
export const POLICY_END = `<!-- synthra-policy v${POLICY_VERSION} END -->`;

// Matches a synthra-policy block of any version, e.g. v1, v2 …
const ANY_BLOCK_RE = /<!--\s*synthra-policy\s+v\d+\s+BEGIN\s*-->[\s\S]*?<!--\s*synthra-policy\s+v\d+\s+END\s*-->\s*/g;

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
    "> `mcp__synthra__graph_register_edit`. Below they are referred to by",
    "> their short names (`graph_continue` etc.) for readability — use the",
    "> full namespaced form when actually invoking them.",
    "",
    "### Tools",
    "",
    "- **`graph_continue(query)`** — returns a `Confidence` label, the list",
    "  of relevant `Files`, and signatures + top function bodies for those",
    "  files. Your default first move when you need project context.",
    "- **`graph_read(target)`** — fetch source. Prefer the",
    "  `\"file/path.ts::SymbolName\"` form over a bare file path — reading one",
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
    "If skipping, go directly to `graph_read(\"file.ts::symbol\")` on what",
    "you already know.",
    "",
    "### Confidence caps",
    "",
    "When `graph_continue` returns:",
    "",
    "- **`Confidence: high`** → Stop. Do NOT Grep, Glob, or further explore",
    "  for this query. The graph already has it.",
    "- **`Confidence: medium`** → Read the listed `Files` directly via",
    "  `graph_read(\"file::symbol\")` *before* trying Grep. The graph has",
    "  narrowed the search space — use it, don't bypass it.",
    "- **`Confidence: low`** → You may use Grep / Glob, but the PreToolUse",
    "  hook may still block redundant calls.",
    "",
    "### Reading code",
    "",
    "- **Always use `file::symbol` notation** with `graph_read`. Whole-file",
    "  reads should be rare — only when you genuinely need the full file.",
    "- If `graph_continue`'s `Files` list contains a `::` entry, pass it",
    "  verbatim to `graph_read`.",
    "",
    "### Don'ts",
    "",
    "- Don't Grep / Glob before calling `graph_continue` when required — the",
    "  PreToolUse hook may block it.",
    "- Don't call `graph_continue` more than once per turn.",
    "- Don't read whole files when a symbol-level read would suffice.",
    "",
    "### Session-end resume note",
    "",
    "When the user signals they're done (e.g. \"bye\", \"wrap up\", \"done\"),",
    "proactively update `.synthra/CONTEXT.md` with:",
    "",
    "- **Current Task**: one sentence on what was being worked on",
    "- **Key Decisions**: bullet list, max 3 items",
    "- **Next Steps**: bullet list, max 3 items",
    "",
    "Keep `CONTEXT.md` under 20 lines total. Don't summarise the conversation",
    "— write only what's needed to resume next session.",
    "",
    "_This block is managed by Synthra. Edits inside the BEGIN/END markers",
    "are overwritten on every `syn .` run._",
    "",
    POLICY_END,
  ].join("\n");
}

export async function patchClaudeMd(path: string): Promise<PatchResult> {
  let existing: string | null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = null;
  }

  const block = policyBlock();

  if (existing === null) {
    await writeFile(path, block + "\n", "utf8");
    return { created: true, updated: false, skipped: false };
  }

  const stripped = existing.replace(ANY_BLOCK_RE, "");
  const hadBlock = stripped !== existing;

  const desired = stripped.endsWith("\n")
    ? stripped + "\n" + block + "\n"
    : (stripped.length ? stripped + "\n\n" : "") + block + "\n";

  if (hadBlock && desired === existing) {
    return { created: false, updated: false, skipped: true };
  }

  await writeFile(path, desired, "utf8");
  return { created: false, updated: true, skipped: false };
}
