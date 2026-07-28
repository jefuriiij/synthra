// Grouping + filtering for the Arsenal browser. Pure on purpose: the dashboard
// has no component-test harness, so keeping this logic out of the .svelte file
// is the only way it gets covered (same pattern as delta.ts's summarizeRoutes).

import type { ArsenalItem, ArsenalScope } from "./types";

/** Key of the always-present "everything" row in the group panel. */
export const GROUP_ALL = "all";

export interface ArsenalGroup {
  /** Stable identity: "all" | "project" | "personal" | "plugin:<source>". */
  key: string;
  /** Human label — plugin sources are prettified for display only. */
  label: string;
  /** Drives the scope dot color; "all" for the everything row. */
  scope: ArsenalScope | "all";
  items: ArsenalItem[];
}

const SCOPE_LABEL: Record<ArsenalScope, string> = {
  project: "In this project",
  personal: "Personal",
  plugin: "Plugin",
};

// Keep real acronyms shouting — "voltagent-data-ai" reads badly as "Data Ai".
const ACRONYMS = new Set(["ai", "ui", "ux", "qa", "mcp", "api", "cli", "seo", "sms", "cro"]);

/** `marketing-skills` → `Marketing Skills`, `voltagent-qa-sec` → `Voltagent QA
 *  Sec`. Display only — the raw source stays the group key so it remains
 *  greppable against the on-disk plugin name. */
export function prettyPluginLabel(source: string): string {
  return source
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The Arsenal's existing search: name, description, or plugin source. */
export function filterItems(items: ArsenalItem[], query: string): ArsenalItem[] {
  const needle = query.toLowerCase().trim();
  if (!needle) return items;
  return items.filter(
    (it) =>
      it.name.toLowerCase().includes(needle) ||
      (it.description ?? "").toLowerCase().includes(needle) ||
      (it.source ?? "").toLowerCase().includes(needle),
  );
}

function groupKey(item: ArsenalItem): string {
  return item.scope === "plugin" ? `plugin:${item.source ?? "plugin"}` : item.scope;
}

const SCOPE_ORDER: Record<ArsenalScope, number> = { project: 0, personal: 1, plugin: 2 };

/**
 * Build the group panel's rows: an "All" row, then project / personal, then one
 * row per plugin alphabetically. Only non-empty groups are returned, so a
 * filtered-to-nothing plugin simply disappears from the panel.
 */
export function buildGroups(items: ArsenalItem[]): ArsenalGroup[] {
  const map = new Map<string, ArsenalGroup>();
  for (const it of items) {
    const key = groupKey(it);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label: it.scope === "plugin" ? prettyPluginLabel(it.source ?? "plugin") : SCOPE_LABEL[it.scope],
        scope: it.scope,
        items: [],
      };
      map.set(key, g);
    }
    g.items.push(it);
  }

  const rest = [...map.values()].sort((a, b) => {
    const sa = SCOPE_ORDER[a.scope as ArsenalScope];
    const sb = SCOPE_ORDER[b.scope as ArsenalScope];
    if (sa !== sb) return sa - sb;
    return a.label.localeCompare(b.label);
  });

  return [{ key: GROUP_ALL, label: "All", scope: "all", items }, ...rest];
}

/** Keep a selection valid across tab switches, rescans, and filtering — a
 *  plugin with skills may have no agents, and a filter can empty any group. */
export function resolveSelection(groups: ArsenalGroup[], selected: string): string {
  return groups.some((g) => g.key === selected) ? selected : GROUP_ALL;
}

/** Items to render on the right for the current selection. */
export function itemsForSelection(groups: ArsenalGroup[], selected: string): ArsenalItem[] {
  return groups.find((g) => g.key === selected)?.items ?? [];
}
