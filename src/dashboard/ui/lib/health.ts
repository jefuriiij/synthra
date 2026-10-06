// Whether a project's Synthra works, in one place: the sidebar's dots, the
// health table and a project's own page all decide it the same way.

import type { ProjectHealth } from "./types";

const DAY = 24 * 60 * 60 * 1000;

export type HookKey = "start" | "tools" | "reply" | "prompt";

export const HOOK_COLS: { key: HookKey; label: string }[] = [
  { key: "start", label: "Session start" },
  { key: "tools", label: "Tool checks" },
  { key: "reply", label: "Replies" },
  { key: "prompt", label: "Prompts" },
];

const times = (h: ProjectHealth) =>
  Object.values(h.hooks)
    .map((t) => Date.parse(t ?? ""))
    .filter(Number.isFinite);

/** A hook is behind when it never ran, or ran a week or more before the
 *  project's newest hook, while the others kept going. "start" is only
 *  recorded from 0.34 on, so a missing one says nothing. */
export function behind(h: ProjectHealth, key: HookKey): boolean {
  const all = times(h);
  if (all.length === 0) return false;
  const iso = h.hooks[key];
  if (!iso) return key !== "start";
  return Math.max(...all) - Date.parse(iso) >= 7 * DAY;
}

/** When anything of Synthra last ran there (epoch ms; 0 = never). */
export function lastActive(h: ProjectHealth): number {
  return Math.max(0, ...times(h));
}

/** Used in the last 7 days: listed first, not folded away. */
export function isActive(h: ProjectHealth, now = Date.now()): boolean {
  return now - lastActive(h) < 7 * DAY;
}

/** The dot next to a project: needs a look, works, or quiet for a month. */
export function projectDot(h: ProjectHealth, now = Date.now()): "warn" | "ok" | "idle" {
  if (h.problem || HOOK_COLS.some((c) => behind(h, c.key))) return "warn";
  return now - lastActive(h) < 30 * DAY ? "ok" : "idle";
}

export const HOOKS_STATE_LABEL: Record<ProjectHealth["hooks_state"], string> = {
  current: "hooks up to date",
  outdated: "hooks out of date",
  missing: "no hooks",
  newer: "hooks from a newer Synthra",
};
