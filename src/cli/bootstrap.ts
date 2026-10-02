// Project bootstrap: creates .synthra-graph/, .synthra/ (with an empty
// MEMORY.md), updates .gitignore, patches CLAUDE.md with the versioned policy
// block (which imports AGENTS.md) and AGENTS.md with the rules starter and the
// block other AI tools read.

import { mkdir, readFile, stat } from "node:fs/promises";

import { updateTextFile } from "../shared/json-store.js";
import { basename } from "node:path";

import { AGENTS_TITLE, patchAgentsMd, stripAgentsBlock } from "../hooks/agents-md.js";
import { isSynthraOnlyClaudeMd, patchClaudeMd } from "../hooks/claude-md.js";
import { ensureProjectKnowledge } from "../memory/knowledge.js";
import { loadConfig } from "../shared/config.js";
import type { SynthraPaths } from "../shared/paths.js";

export interface BootstrapResult {
  graphCreated: boolean;
  contextCreated: boolean;
  gitignoreUpdated: boolean;
  claudeMdUpdated: boolean;
  claudeMdCreated: boolean;
  agentsMdUpdated: boolean;
  agentsMdCreated: boolean;
  /** AGENTS.md gained the rules starter on this run. */
  agentsMdScaffolded: boolean;
  memoryMdCreated: boolean;
}

// Entries Synthra appends to the project .gitignore on bootstrap.
// Each is gated by a check: if the entry is already present (any
// indentation, trimmed match), it's skipped. Comments are per-entry so
// users understand why each line is there and can remove what they don't
// want without breaking the rest.
export const GITIGNORE_ENTRIES: { comment: string; entry: string }[] = [
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
  // Through updateTextFile because .gitignore is user-owned and we only ever
  // append to it: reading, computing and writing as separate steps would drop
  // any line they added in the gap. The mutate below is pure and re-runs
  // against whatever actually landed.
  const result = await updateTextFile(path, (current) => {
    const existing = current ?? "";
    const trimmed = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = GITIGNORE_ENTRIES.filter((e) => !trimmed.has(e.entry));
    if (missing.length === 0) return null; // already ours — write nothing

    const block = missing.map((m) => `# ${m.comment}\n${m.entry}`).join("\n") + "\n";
    const appendix =
      (existing.length === 0 || existing.endsWith("\n") ? "" : "\n") +
      (existing.length ? "\n" : "") +
      block;
    return existing + appendix;
  });
  return result.status === "written";
}

export async function bootstrap(paths: SynthraPaths): Promise<BootstrapResult> {
  const graphCreated = await ensureDir(paths.graphDir);
  const contextCreated = await ensureDir(paths.contextDir);
  const gitignoreUpdated = await patchGitignore(paths.gitignore);

  const name = basename(paths.projectRoot);
  const read = (p: string) => readFile(p, "utf8").catch(() => null);
  const [claudeBefore, agentsBefore] = await Promise.all([
    read(paths.claudeMd),
    read(paths.agentsMd),
  ]);
  // The rules starter goes into AGENTS.md unless the user already keeps rules
  // in CLAUDE.md: those stay where they are, and a second, empty set would
  // only confuse.
  const scaffold = claudeBefore === null || isSynthraOnlyClaudeMd(claudeBefore, name);
  const agentsRest = agentsBefore === null ? "" : stripAgentsBlock(agentsBefore).trim();
  const willScaffold = scaffold && (agentsRest === "" || agentsRest === AGENTS_TITLE);

  const patch = await patchClaudeMd(paths.claudeMd, name);
  const agents = await patchAgentsMd(paths.agentsMd, { projectName: name, scaffold });
  // Claude Code hot-reloads skills, but only in skills folders that existed
  // when the session started: make the project's now, so the first skill
  // Synthra writes here shows up without a /reload-skills.
  await mkdir(paths.projectSkillsDir, { recursive: true });
  const memoryMdCreated = await ensureProjectKnowledge(paths.memoryMd, loadConfig().memoryChars);

  return {
    graphCreated,
    contextCreated,
    gitignoreUpdated,
    claudeMdUpdated: patch.updated,
    claudeMdCreated: patch.created && claudeBefore === null,
    agentsMdUpdated: agents.updated,
    agentsMdCreated: agents.created,
    agentsMdScaffolded: willScaffold && (agents.created || agents.updated),
    memoryMdCreated,
  };
}
