// Locate the most recently modified Claude session transcript for a project.
// Claude Code stores them at: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where encoded-cwd replaces \ and / with -.
// TODO: M3

export interface DiscoveredSession {
  sessionId: string;
  transcriptPath: string;
  modifiedAt: Date;
}

export async function findLatestSession(_projectRoot: string): Promise<DiscoveredSession | null> {
  throw new Error("Synthra: findLatestSession not yet implemented (M3)");
}

export function encodeProjectPath(_projectRoot: string): string {
  throw new Error("Synthra: encodeProjectPath not yet implemented (M3)");
}
