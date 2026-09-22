// Shared shape + strip logic for Synthra's entries in .claude/settings.local.json.
// Lives apart from installer.ts (which imports raw .ps1/.sh script text) so that
// consumers like `syn remove` — and their tests — don't drag script assets into
// their module graph.

export const SYNTHRA_HOOK_MARKER = "synthra-hook=true";

/** Every hook we register runs a script we wrote at
 *  `<project>/.claude/hooks/synthra-<name>.ps1|sh`, and that path is baked into
 *  the command string. That string is the only part of the entry we can trust.
 *
 *  The `meta` marker alone is not enough: Claude Code owns settings.local.json
 *  too, and when it rewrites the file it drops keys outside its own hook schema
 *  — `meta` included. Once the marker is gone, `stripOurHooks` no longer
 *  recognizes the entry, so the next `syn .` appends a SECOND registration
 *  instead of replacing the first. Both then fire on every event: two /route
 *  posts per prompt (visible as doubled rows in the dashboard's Recent
 *  decisions), two /gate calls per Grep/Glob/Bash, two CONTEXT.md refreshes.
 *  It compounds — one real install had seven copies of every hook.
 *
 *  Note this is not a legacy problem: every version since 0.1.1 has stamped the
 *  marker, so an entry without one is not an old install — it is an entry Claude
 *  Code has rewritten, which can happen to any install, however fresh.
 *
 *  Matching on the command path fixes that for good. We still WRITE `meta`: it
 *  costs nothing, it documents the entry for anyone reading the file, and it
 *  still identifies an entry whose script path was later edited by hand. */
const OUR_HOOK_COMMAND = /[\\/]\.claude[\\/]hooks[\\/]synthra-[\w.-]+\.(?:ps1|sh)/i;

/** True when this hook command runs one of our scripts, marker or not. */
export function isOurHookCommand(command: unknown): boolean {
  return typeof command === "string" && OUR_HOOK_COMMAND.test(command);
}

/** How many of our hooks are registered per event. More than one for the same
 *  event means that event fires that many times — what `syn doctor` reports and
 *  what the next `syn .` repairs. Callers must pass PARSED settings: the raw
 *  file text can't be matched reliably, because JSON escapes every Windows path
 *  separator into a pair of backslashes. */
export function ourHookCounts(config: HooksConfig): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [event, entries] of Object.entries(config.hooks ?? {})) {
    const n = (entries ?? [])
      .flatMap((e) => e.hooks ?? [])
      .filter((h) => isOurHookCommand(h.command)).length;
    if (n > 0) counts.set(event, n);
  }
  return counts;
}

export interface HooksConfig {
  hooks?: {
    [event: string]: Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; meta?: string }>;
    }>;
  };
  [k: string]: unknown;
}

/** Drop every hook entry Synthra installed — identified by the script path in
 *  its command, or by the legacy `meta` marker — preserving user hooks and
 *  pruning event arrays that become empty. */
export function stripOurHooks(config: HooksConfig): HooksConfig {
  if (!config.hooks) return config;
  const next: HooksConfig["hooks"] = {};
  for (const [event, entries] of Object.entries(config.hooks)) {
    const filtered = entries
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter(
          (h) => h.meta !== SYNTHRA_HOOK_MARKER && !isOurHookCommand(h.command),
        ),
      }))
      .filter((entry) => (entry.hooks?.length ?? 0) > 0);
    if (filtered.length) next[event] = filtered;
  }
  config.hooks = next;
  return config;
}
