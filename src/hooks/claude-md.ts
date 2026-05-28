// Idempotent patcher for the project's CLAUDE.md. Manages a single block
// bounded by <!-- synthra-policy v<N> BEGIN --> ... <!-- synthra-policy v<N> END -->.
// On each run, any prior synthra-policy block (any version) is removed and the
// current-version block is appended at the end.

import { readFile, writeFile } from "node:fs/promises";

export const POLICY_VERSION = 1;
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
    "Synthra has pre-loaded a structured context pack into this session and",
    "exposes the project's code graph through three MCP tools. **Prefer these",
    "tools over Grep / Glob** — they are faster, cheaper, and already filtered",
    "to relevant files.",
    "",
    "### Tools",
    "",
    "- **`graph_continue(query)`** — your default first move when you need",
    "  project context. Returns signatures + top function bodies + linked test",
    "  files, with a `confidence` label. If `confidence === \"high\"`, **stop**:",
    "  do not call Grep/Glob for the same query.",
    "- **`graph_read(target)`** — fetch source for a specific `\"file/path.ts\"`",
    "  or `\"file/path.ts::SymbolName\"`. Use this once you know what you want.",
    "- **`graph_register_edit(files)`** — after you edit files, call this so",
    "  Synthra ranks them higher and avoids surfacing stale snapshots.",
    "",
    "### Rules",
    "",
    "1. Call `graph_continue` **before** Grep / Glob for any question about",
    "   project code. Grep / Glob calls for the same query may be blocked at",
    "   the hook layer when the graph already has a confident answer.",
    "2. When `graph_continue` returns `confidence: \"high\"`, treat the pack as",
    "   authoritative — don't second-guess it with a Grep.",
    "3. Use `graph_read` instead of `Read` when you only need a specific symbol",
    "   from a file (you get less noise + line numbers).",
    "4. After editing files, call `graph_register_edit(files)` so subsequent",
    "   turns weight your changes correctly.",
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
