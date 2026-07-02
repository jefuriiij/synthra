// `syn remove [path]` — the uninstall mirror of `syn .`. Deletes Synthra's
// state dirs and strips its pieces out of shared files (.gitignore, CLAUDE.md,
// .claude/settings.local.json, .mcp.json) without touching user content; those
// files are deleted only when nothing else remains. Also deregisters the MCP
// entry (via the claude CLI, with a direct .mcp.json fallback) and forgets the
// project in the global dashboard registry.
//
// Structure mirrors doctor-command.ts: a pure, testable core (removeSynthra)
// plus a printing/prompting wrapper (removeCommand).

import { readFile, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { onboardingSkeleton, stripPolicyBlock } from "../hooks/claude-md.js";
import { stripOurHooks, type HooksConfig } from "../hooks/hooks-config.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { resolvePaths, type SynthraPaths } from "../shared/paths.js";
import { forgetProject } from "../shared/project-registry.js";
import { GITIGNORE_ENTRIES } from "./bootstrap.js";
import { promptYesNo } from "./self-update.js";
import { unregisterMcp } from "./start-claude.js";

export interface RemovalResult {
  /** Artifacts deleted or stripped. */
  removed: string[];
  /** Shared files kept because user content remains (Synthra pieces stripped). */
  kept: string[];
  /** Artifacts that weren't present (or couldn't be processed). */
  skipped: string[];
}

const HOOK_BASENAMES = [
  "synthra-prime",
  "synthra-pre-tool-use",
  "synthra-pre-compact",
  "synthra-stop",
  "synthra-route",
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Strip Synthra's appended entries (and their `# added by synthra…` comment
 *  lines) from a .gitignore body. Returns the remaining content. */
export function stripGitignoreEntries(content: string): string {
  const entries = new Set(GITIGNORE_ENTRIES.map((e) => e.entry));
  const lines = content.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (entries.has(t)) return false;
    if (t.startsWith("# added by synthra")) return false;
    return true;
  });
  return lines.join("\n");
}

/**
 * Reverse everything `syn .` bootstrapped into a project. Pure core — no
 * prompting, no MCP-CLI spawn, no registry writes (the wrapper handles those).
 * Every step is best-effort: a missing artifact is reported as skipped.
 */
export async function removeSynthra(projectRootRaw: string): Promise<RemovalResult> {
  const projectRoot = resolve(projectRootRaw);
  const paths = resolvePaths(projectRoot);
  const result: RemovalResult = { removed: [], kept: [], skipped: [] };

  // 1. State directories — .synthra-graph/ (machine-local) + .synthra/ (memory).
  for (const [label, dir] of [
    [".synthra-graph/", paths.graphDir],
    [".synthra/ (context store)", paths.contextDir],
  ] as const) {
    if (await exists(dir)) {
      await rm(dir, { recursive: true, force: true });
      result.removed.push(label);
    } else {
      result.skipped.push(label);
    }
  }

  // 2. .gitignore — strip Synthra's entries + comments; delete if empty after.
  const gitignore = await readIfExists(paths.gitignore);
  if (gitignore === null) {
    result.skipped.push(".gitignore");
  } else {
    const stripped = stripGitignoreEntries(gitignore);
    if (stripped === gitignore) {
      result.skipped.push(".gitignore (no synthra entries)");
    } else if (stripped.trim().length === 0) {
      await unlink(paths.gitignore);
      result.removed.push(".gitignore (was synthra-only)");
    } else {
      await writeFile(paths.gitignore, stripped.trimEnd() + "\n", "utf8");
      result.kept.push(".gitignore (synthra entries stripped)");
    }
  }

  // 3. CLAUDE.md — strip the policy block; delete the file only when what's
  // left is empty or the pristine untouched onboarding skeleton.
  const claudeMd = await readIfExists(paths.claudeMd);
  if (claudeMd === null) {
    result.skipped.push("CLAUDE.md");
  } else {
    const remainder = stripPolicyBlock(claudeMd);
    if (remainder === claudeMd) {
      result.skipped.push("CLAUDE.md (no synthra policy block)");
    } else {
      const pristine = onboardingSkeleton(basename(projectRoot)).trim();
      if (remainder.trim().length === 0 || remainder.trim() === pristine) {
        await unlink(paths.claudeMd);
        result.removed.push("CLAUDE.md (was synthra-generated)");
      } else {
        await writeFile(paths.claudeMd, remainder.trimEnd() + "\n", "utf8");
        result.kept.push("CLAUDE.md (policy block stripped, your content kept)");
      }
    }
  }

  // 4. Hook scripts — both platforms' extensions; drop the dir only if empty.
  let hooksRemoved = 0;
  for (const base of HOOK_BASENAMES) {
    for (const ext of [".ps1", ".sh"]) {
      const p = join(paths.claudeHooksDir, `${base}${ext}`);
      if (await exists(p)) {
        await unlink(p);
        hooksRemoved += 1;
      }
    }
  }
  if (hooksRemoved > 0) {
    result.removed.push(`.claude/hooks/synthra-* (${hooksRemoved} script(s))`);
    try {
      if ((await readdir(paths.claudeHooksDir)).length === 0) await rmdir(paths.claudeHooksDir);
    } catch {
      // dir busy or already gone — fine
    }
  } else {
    result.skipped.push(".claude/hooks/synthra-*");
  }

  // 5. .claude/settings.local.json — strip only synthra-marked hooks; keep the
  // file whenever any user configuration remains.
  const settingsRaw = await readIfExists(paths.claudeSettings);
  if (settingsRaw === null) {
    result.skipped.push(".claude/settings.local.json");
  } else {
    try {
      const config = stripOurHooks(JSON.parse(settingsRaw) as HooksConfig);
      if (config.hooks && Object.keys(config.hooks).length === 0) delete config.hooks;
      if (Object.keys(config).length === 0) {
        await unlink(paths.claudeSettings);
        result.removed.push(".claude/settings.local.json (was synthra-only)");
      } else {
        await writeFile(paths.claudeSettings, JSON.stringify(config, null, 2) + "\n", "utf8");
        result.kept.push(".claude/settings.local.json (synthra hooks stripped)");
      }
    } catch {
      result.skipped.push(".claude/settings.local.json (unparseable — left untouched)");
    }
  }

  // 6. .mcp.json — direct fallback for when the claude CLI wasn't available to
  // deregister: drop the synthra server entry; delete the file if it was the
  // only thing in there.
  const mcpPath = join(projectRoot, ".mcp.json");
  const mcpRaw = await readIfExists(mcpPath);
  if (mcpRaw === null) {
    result.skipped.push(".mcp.json");
  } else {
    try {
      const mcp = JSON.parse(mcpRaw) as { mcpServers?: Record<string, unknown> };
      const servers = mcp.mcpServers ?? {};
      const hadSynthra = "synthra" in servers;
      if (hadSynthra) delete servers.synthra;
      const serversEmpty = Object.keys(servers).length === 0;
      const onlyServersKey = Object.keys(mcp).length === 1 && "mcpServers" in mcp;
      if (serversEmpty && onlyServersKey) {
        await unlink(mcpPath);
        result.removed.push(".mcp.json (was synthra-only)");
      } else if (hadSynthra) {
        await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");
        result.kept.push(".mcp.json (synthra entry removed)");
      } else {
        result.skipped.push(".mcp.json (no synthra entry)");
      }
    } catch {
      result.skipped.push(".mcp.json (unparseable — left untouched)");
    }
  }

  return result;
}

/** What Synthra artifacts exist here — the summary shown before the confirm. */
async function inventory(projectRoot: string, paths: SynthraPaths): Promise<string[]> {
  const found: string[] = [];
  if (await exists(paths.graphDir)) found.push(".synthra-graph/  (graph + logs, machine-local)");
  if (await exists(paths.contextDir)) {
    found.push(".synthra/  (context store — git-tracked project memory)");
  }
  const gitignore = await readIfExists(paths.gitignore);
  if (gitignore?.includes("added by synthra")) found.push(".gitignore  (synthra entries)");
  const claudeMd = await readIfExists(paths.claudeMd);
  if (claudeMd?.includes("synthra-policy")) found.push("CLAUDE.md  (synthra policy block)");
  const settings = await readIfExists(paths.claudeSettings);
  if (settings?.includes("synthra-hook=true")) {
    found.push(".claude/settings.local.json + hooks/synthra-*  (hooks)");
  }
  const mcp = await readIfExists(join(projectRoot, ".mcp.json"));
  if (mcp?.includes('"synthra"')) found.push(".mcp.json  (MCP registration)");
  return found;
}

export async function removeCommand(rawPath: string, opts: { yes?: boolean } = {}): Promise<void> {
  const projectRoot = resolve(rawPath);
  const paths = resolvePaths(projectRoot);

  const found = await inventory(projectRoot, paths);
  if (found.length === 0) {
    await forgetProject(projectRoot);
    log.info(`nothing to remove — Synthra doesn't appear to be installed in ${projectRoot}`);
    return;
  }

  log.info(`removing Synthra from ${projectRoot}`);
  log.info("this will delete / strip:");
  for (const f of found) log.info(`  • ${f}`);

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      log.info("not a TTY — re-run with --yes to confirm removal.");
      return;
    }
    const ok = await promptYesNo("[syn] Remove Synthra from this project? [y/N]: ");
    if (!ok) {
      log.info("aborted — nothing was changed.");
      return;
    }
  }

  // Deregister via the claude CLI first (writes .mcp.json); the core's direct
  // .mcp.json fallback covers machines where `claude` isn't on PATH.
  try {
    await unregisterMcp(loadConfig().claudeBin, projectRoot);
  } catch {
    // best-effort
  }

  const result = await removeSynthra(projectRoot);
  const forgot = await forgetProject(projectRoot);

  for (const r of result.removed) log.info(`  removed  ${r}`);
  for (const k of result.kept) log.info(`  kept     ${k}`);
  if (forgot) log.info("  removed  dashboard registry entry");
  log.info("done — Synthra is no longer installed in this project.");
}
