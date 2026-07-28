// Grouping + filtering for the Arsenal browser. Pure on purpose: the dashboard
// has no component-test harness, so keeping this logic out of the .svelte file
// is the only way it gets covered (same pattern as delta.ts's summarizeRoutes).

import type { ArsenalItem, ArsenalScope } from "./types";

/** Key of the always-present "everything" row in the group panel. */
export const GROUP_ALL = "all";

/** A group row's kind. NOT the same thing as an item's disk scope: a `pack`
 *  row's items are personal-scope files, but the row stands on its own. */
export type ArsenalGroupKind = ArsenalScope | "all" | "pack";

export interface ArsenalGroup {
  /** Stable identity: "all" | "project" | "personal" | "pack:<pack>" | "plugin:<source>". */
  key: string;
  /** Human label — plugin and pack sources are prettified for display only. */
  label: string;
  /** Drives the scope dot color and the band dividers. */
  scope: ArsenalGroupKind;
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
 *  Sec`, `impeccable` → `Impeccable`. Serves both plugin sources and pack
 *  names. Display only — the raw value stays the group key so it remains
 *  greppable against the on-disk name. */
export function prettyPluginLabel(source: string): string {
  return source
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Stable identity of an item within a tab — the `{#each}` key and the base of
 *  the detail cache key. Separator-delimited on purpose: plain concatenation
 *  collides (source "a" + name "b-c" === source "a-b" + name "c"), and a
 *  duplicate key is a hard Svelte error. */
export function itemKey(item: ArsenalItem): string {
  return `${item.scope}|${item.source ?? ""}|${item.name}`;
}

/** The row an item belongs to: pack membership outranks disk scope. */
export function itemKind(item: ArsenalItem): ArsenalGroupKind {
  return item.pack ? "pack" : item.scope;
}

/** Card badge text: pack name, else plugin source, else the scope word. */
export function itemBadge(item: ArsenalItem): string {
  if (item.pack) return item.pack;
  return item.scope === "plugin" ? (item.source ?? "plugin") : item.scope;
}

/** Dot / badge color per group kind. Lives here rather than in the components
 *  so the pack color is defined once and gets test coverage. */
export function scopeColor(kind: ArsenalGroupKind | string): string {
  switch (kind) {
    case "project":
      return "var(--c-fable)";
    case "personal":
      return "var(--c-sonnet)";
    case "pack":
      return "var(--c-haiku)";
    case "all":
      return "var(--muted-foreground)";
    default:
      return "#9bc2ef"; // plugin
  }
}

/** The Arsenal's existing search: name, description, plugin source, or pack. */
export function filterItems(items: ArsenalItem[], query: string): ArsenalItem[] {
  const needle = query.toLowerCase().trim();
  if (!needle) return items;
  return items.filter(
    (it) =>
      it.name.toLowerCase().includes(needle) ||
      (it.description ?? "").toLowerCase().includes(needle) ||
      (it.source ?? "").toLowerCase().includes(needle) ||
      (it.pack ?? "").toLowerCase().includes(needle),
  );
}

function groupKey(item: ArsenalItem): string {
  if (item.pack) return `pack:${item.pack}`;
  return item.scope === "plugin" ? `plugin:${item.source ?? "plugin"}` : item.scope;
}

function groupLabel(item: ArsenalItem): string {
  if (item.pack) return prettyPluginLabel(item.pack);
  return item.scope === "plugin" ? prettyPluginLabel(item.source ?? "plugin") : SCOPE_LABEL[item.scope];
}

const KIND_ORDER: Record<ArsenalGroupKind, number> = {
  all: -1,
  project: 0,
  personal: 1,
  pack: 2,
  plugin: 3,
};

/** The pack's own SKILL.md leads its row — its description explains the whole
 *  family, and server order would otherwise bury it among its own commands. */
function isPackParent(item: ArsenalItem): boolean {
  return !!item.pack && !item.pack_command;
}

/**
 * Build the group panel's rows: an "All" row, then project / personal, then
 * packs, then one row per plugin alphabetically. Only non-empty groups are
 * returned, so a filtered-to-nothing plugin simply disappears from the panel.
 *
 * Every item lands in exactly ONE row (a pack member is not also Personal),
 * which is what keeps All's count equal to the sum of the others.
 */
export function buildGroups(items: ArsenalItem[]): ArsenalGroup[] {
  const map = new Map<string, ArsenalGroup>();
  for (const it of items) {
    const key = groupKey(it);
    let g = map.get(key);
    if (!g) {
      g = { key, label: groupLabel(it), scope: itemKind(it), items: [] };
      map.set(key, g);
    }
    g.items.push(it);
  }

  const rest = [...map.values()].sort((a, b) => {
    const sa = KIND_ORDER[a.scope];
    const sb = KIND_ORDER[b.scope];
    if (sa !== sb) return sa - sb;
    return a.label.localeCompare(b.label);
  });

  // Hoist each pack's parent; leave the remaining order exactly as the server
  // sorted it, or the row would silently diverge from All.
  for (const g of rest) {
    if (g.scope !== "pack") continue;
    g.items = [...g.items.filter(isPackParent), ...g.items.filter((i) => !isPackParent(i))];
  }

  return [{ key: GROUP_ALL, label: "All", scope: "all", items }, ...rest];
}

/** Visual bands in the group panel: [All + own scopes] | [packs] | [plugins].
 *  A divider is drawn wherever the band changes. */
function band(kind: ArsenalGroupKind): number {
  return kind === "pack" ? 1 : kind === "plugin" ? 2 : 0;
}

/** True when row `index` opens a new band and wants a divider above it. */
export function startsNewBand(groups: ArsenalGroup[], index: number): boolean {
  const cur = groups[index];
  const prev = groups[index - 1];
  if (!cur || !prev) return false;
  return band(cur.scope) !== band(prev.scope);
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
