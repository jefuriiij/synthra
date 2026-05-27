// Branch-aware routing for the context store.
// On the default branch, reads/writes go to .synthra/context-store.json.
// On a feature branch, they go to .synthra/branches/<sanitized-branch>/context-store.json.
// TODO: M4 — improvement #2

export async function currentBranch(_projectRoot: string): Promise<string> {
  throw new Error("Synthra: currentBranch not yet implemented (M4)");
}

export async function defaultBranch(_projectRoot: string): Promise<string> {
  throw new Error("Synthra: defaultBranch not yet implemented (M4)");
}

export function sanitizeBranchName(name: string): string {
  return name.replaceAll("/", "-").replaceAll("\\", "-");
}

export interface BranchScopedPaths {
  contextStore: string;
  contextMd: string;
}

export function resolveBranchPaths(
  _contextDir: string,
  _branch: string,
  _isDefault: boolean,
): BranchScopedPaths {
  throw new Error("Synthra: resolveBranchPaths not yet implemented (M4)");
}
