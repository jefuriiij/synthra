// Resolves Synthra's storage locations inside a project root.

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Canonical form of a project root, for comparison only — never for display or
 * for building paths.
 *
 * Windows hands us the same directory spelled several ways: `C:\…` from a shell,
 * `c:\…` from an editor's extension host, and either slash direction. The
 * filesystem treats them as one directory, so anything keyed on the raw string
 * silently sees two projects where there is one — two registry entries, whose
 * logs then get read (and counted) twice.
 */
export function normalizeRoot(p: string): string {
  return p
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/** Do these two paths name the same project root? */
export function sameRoot(a: string, b: string): boolean {
  return normalizeRoot(a) === normalizeRoot(b);
}

export interface SynthraPaths {
  projectRoot: string;
  graphDir: string;
  contextDir: string;
  infoGraph: string;
  symbolIndex: string;
  sessionState: string;
  activityLog: string;
  tokenLog: string;
  gateLog: string;
  bashLog: string;
  routeLog: string;
  delegationLog: string;
  toolLog: string;
  /** When each memory or skill reminder fired (0.34+). */
  nudgeLog: string;
  /** When each hook last reached the server (0.34+). */
  heartbeat: string;
  accessLog: string;
  learnStore: string;
  parseCache: string;
  mcpPort: string;
  mcpOwner: string;
  mcpServerLog: string;
  mcpServerErrLog: string;
  contextStore: string;
  contextMd: string;
  /** .synthra/MEMORY.md — what every AI should know about this project. */
  memoryMd: string;
  /** ~/.synthra/USER.md — about the user; private, shared by all projects. */
  userMemory: string;
  branchesDir: string;
  claudeDir: string;
  claudeSettings: string;
  claudeHooksDir: string;
  claudeMd: string;
  /** AGENTS.md — the cross-tool instructions file (Codex, Cursor, Copilot, …). */
  agentsMd: string;
  /** <project>/.claude/skills — skills for this project only. */
  projectSkillsDir: string;
  /** ~/.claude/skills — skills for every project. */
  globalSkillsDir: string;
  /** ~/.synthra/skills — what Synthra keeps about the skills it writes:
   *  proposals waiting for the user, the change ledger, and content blobs. */
  skillState: string;
  gitignore: string;
}

/**
 * Where USER.md lives. SYN_USER_MEMORY moves it (the test suite points it at a
 * path that doesn't exist, so no test ever reads or writes the real one).
 */
export function defaultUserMemory(home: string = homedir()): string {
  return process.env.SYN_USER_MEMORY || join(home, ".synthra", "USER.md");
}

/** ~/.claude/skills, or SYN_GLOBAL_SKILLS (the suite's throwaway folder). */
export function defaultGlobalSkills(home: string = homedir()): string {
  return process.env.SYN_GLOBAL_SKILLS || join(home, ".claude", "skills");
}

/** ~/.synthra/skills, or SYN_SKILL_STATE (the suite's throwaway folder). */
export function defaultSkillState(home: string = homedir()): string {
  return process.env.SYN_SKILL_STATE || join(home, ".synthra", "skills");
}

export function resolvePaths(
  projectRoot: string,
  userMemory: string = defaultUserMemory(),
): SynthraPaths {
  const graphDir = join(projectRoot, ".synthra-graph");
  const contextDir = join(projectRoot, ".synthra");
  const claudeDir = join(projectRoot, ".claude");

  return {
    projectRoot,
    graphDir,
    contextDir,
    infoGraph: join(graphDir, "info_graph.json"),
    symbolIndex: join(graphDir, "symbol_index.json"),
    sessionState: join(graphDir, "session.json"),
    activityLog: join(graphDir, "activity.jsonl"),
    tokenLog: join(graphDir, "token_log.jsonl"),
    gateLog: join(graphDir, "gate_log.jsonl"),
    bashLog: join(graphDir, "bash_log.jsonl"),
    routeLog: join(graphDir, "route_log.jsonl"),
    delegationLog: join(graphDir, "delegation_log.jsonl"),
    toolLog: join(graphDir, "tool_log.jsonl"),
    nudgeLog: join(graphDir, "nudge_log.jsonl"),
    heartbeat: join(graphDir, "heartbeat.json"),
    accessLog: join(graphDir, "access_log.jsonl"),
    learnStore: join(graphDir, "learn_store.json"),
    parseCache: join(graphDir, "parse_cache.json"),
    mcpPort: join(graphDir, "mcp_port"),
    mcpOwner: join(graphDir, "mcp_owner.json"),
    mcpServerLog: join(graphDir, "mcp_server.log"),
    mcpServerErrLog: join(graphDir, "mcp_server.err.log"),
    contextStore: join(contextDir, "context-store.json"),
    contextMd: join(contextDir, "CONTEXT.md"),
    memoryMd: join(contextDir, "MEMORY.md"),
    userMemory,
    branchesDir: join(contextDir, "branches"),
    claudeDir,
    claudeSettings: join(claudeDir, "settings.local.json"),
    claudeHooksDir: join(claudeDir, "hooks"),
    claudeMd: join(projectRoot, "CLAUDE.md"),
    agentsMd: join(projectRoot, "AGENTS.md"),
    projectSkillsDir: join(claudeDir, "skills"),
    globalSkillsDir: defaultGlobalSkills(),
    skillState: defaultSkillState(),
    gitignore: join(projectRoot, ".gitignore"),
  };
}
