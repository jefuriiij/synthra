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
  // The full policy text is finalized in M3. For now a minimal placeholder
  // keeps the block detectable and explains itself.
  return [
    POLICY_BEGIN,
    "## Synthra context policy",
    "",
    "Synthra has pre-loaded a structured pack of this project's context into",
    "this session. Prefer the pre-loaded context and `graph_*` MCP tools over",
    "Grep/Glob for navigation. The full policy is finalized in M3.",
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
