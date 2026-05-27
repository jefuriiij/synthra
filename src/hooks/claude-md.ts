// Idempotent patcher for the project's CLAUDE.md. Manages a single block
// bounded by <!-- synthra-policy v<N> BEGIN --> ... <!-- synthra-policy v<N> END -->.
// Future versions find-and-replace the prior block.
// TODO: M1 (write); M3 (sync with hooks)

export const POLICY_VERSION = 1;
export const POLICY_BEGIN = `<!-- synthra-policy v${POLICY_VERSION} BEGIN -->`;
export const POLICY_END = `<!-- synthra-policy v${POLICY_VERSION} END -->`;

export interface PatchResult {
  created: boolean;
  updated: boolean;
  skipped: boolean;
}

export async function patchClaudeMd(_path: string): Promise<PatchResult> {
  throw new Error("Synthra: patchClaudeMd not yet implemented (M1)");
}

export function policyBlock(): string {
  // TODO: M3 — the actual policy text (graph_continue rule, confidence caps, etc.)
  return [
    POLICY_BEGIN,
    "# Synthra Context Policy",
    "",
    "(policy text TBD — see ROADMAP.md M3)",
    "",
    POLICY_END,
  ].join("\n");
}
