// Locate the most recently modified Claude session transcript for a project.
// Claude Code stores them at: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where `encoded-cwd` replaces ANY of \ / : with -.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredSession {
  sessionId: string;
  transcriptPath: string;
  modifiedAt: Date;
}

export function encodeProjectPath(projectRoot: string): string {
  return projectRoot.replace(/[\\/:]/g, "-");
}

export async function findLatestSession(projectRoot: string): Promise<DiscoveredSession | null> {
  const encoded = encodeProjectPath(projectRoot);
  const dir = join(homedir(), ".claude", "projects", encoded);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) return null;

  let latest: DiscoveredSession | null = null;
  for (const file of jsonlFiles) {
    const path = join(dir, file);
    try {
      const s = await stat(path);
      if (!latest || s.mtime > latest.modifiedAt) {
        latest = {
          sessionId: file.replace(/\.jsonl$/, ""),
          transcriptPath: path,
          modifiedAt: s.mtime,
        };
      }
    } catch {
      // skip unreadable file
    }
  }
  return latest;
}
