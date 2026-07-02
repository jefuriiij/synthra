// Shared shape + strip logic for Synthra's entries in .claude/settings.local.json.
// Lives apart from installer.ts (which imports raw .ps1/.sh script text) so that
// consumers like `syn remove` — and their tests — don't drag script assets into
// their module graph.

export const SYNTHRA_HOOK_MARKER = "synthra-hook=true";

export interface HooksConfig {
  hooks?: {
    [event: string]: Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; meta?: string }>;
    }>;
  };
  [k: string]: unknown;
}

/** Drop every hook entry Synthra installed (marked meta: synthra-hook=true),
 *  preserving user hooks and pruning event arrays that become empty. */
export function stripOurHooks(config: HooksConfig): HooksConfig {
  if (!config.hooks) return config;
  const next: HooksConfig["hooks"] = {};
  for (const [event, entries] of Object.entries(config.hooks)) {
    const filtered = entries
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((h) => h.meta !== SYNTHRA_HOOK_MARKER),
      }))
      .filter((entry) => (entry.hooks?.length ?? 0) > 0);
    if (filtered.length) next[event] = filtered;
  }
  config.hooks = next;
  return config;
}
