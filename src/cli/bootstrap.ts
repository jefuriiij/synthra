// Project bootstrap: creates .synthra-graph/, .synthra/, updates .gitignore,
// patches CLAUDE.md with the versioned policy block.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { patchClaudeMd } from "../hooks/claude-md.js";
import type { SynthraPaths } from "../shared/paths.js";

export interface BootstrapResult {
  graphCreated: boolean;
  contextCreated: boolean;
  gitignoreUpdated: boolean;
  claudeMdUpdated: boolean;
  claudeMdCreated: boolean;
}

// Entries Synthra appends to the project .gitignore on bootstrap.
// Each is gated by a check: if the entry is already present (any
// indentation, trimmed match), it's skipped. Comments are per-entry so
// users understand why each line is there and can remove what they don't
// want without breaking the rest.
const GITIGNORE_ENTRIES: { comment: string; entry: string }[] = [
  {
    comment: "added by synthra (heavy generated state — gitignored by design)",
    entry: ".synthra-graph/",
  },
  {
    comment:
      "added by synthra — MCP registration. Remove this line if you want " +
      "to share the synthra MCP entry with teammates via committed .mcp.json",
    entry: ".mcp.json",
  },
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<boolean> {
  const had = await exists(path);
  await mkdir(path, { recursive: true });
  return !had;
}

async function patchGitignore(path: string): Promise<boolean> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    /* file may not exist */
  }
  const trimmed = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !trimmed.has(e.entry));
  if (missing.length === 0) return false;

  const block =
    missing.map((m) => `# ${m.comment}\n${m.entry}`).join("\n") + "\n";
  const appendix =
    (existing.length === 0 || existing.endsWith("\n") ? "" : "\n") +
    (existing.length ? "\n" : "") +
    block;
  await writeFile(path, existing + appendix, "utf8");
  return true;
}

export async function bootstrap(paths: SynthraPaths): Promise<BootstrapResult> {
  const graphCreated = await ensureDir(paths.graphDir);
  const contextCreated = await ensureDir(paths.contextDir);
  const gitignoreUpdated = await patchGitignore(paths.gitignore);

  const claudeMdExistedBefore = await exists(paths.claudeMd);
  const patch = await patchClaudeMd(paths.claudeMd);

  return {
    graphCreated,
    contextCreated,
    gitignoreUpdated,
    claudeMdUpdated: patch.updated,
    claudeMdCreated: patch.created && !claudeMdExistedBefore,
  };
}
