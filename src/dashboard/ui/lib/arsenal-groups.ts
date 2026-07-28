// Grouping + filtering for the Arsenal browser. Pure on purpose: the dashboard
// has no component-test harness, so keeping this logic out of the .svelte file
// is the only way it gets covered (same pattern as delta.ts's summarizeRoutes).

import type { ArsenalItem, ArsenalKind, ArsenalScope } from "./types";

/** Key of the always-present "everything" row in the group panel. */
export const GROUP_ALL = "all";
/** Key of the cross-cutting "favorited" row, shown under All when non-empty. */
export const GROUP_FAVORITES = "favorites";

/** A group row's kind. NOT the same thing as an item's disk scope: a `pack`
 *  row's items are personal-scope files, but the row stands on its own, and
 *  `favorites` mixes every scope. */
export type ArsenalGroupKind = ArsenalScope | "all" | "pack" | "favorites";

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

/** Cross-tab identity for the favorites set. `itemKey` is per-tab and omits the
 *  kind; favorites live in ONE machine-wide file, so a skill and an agent of the
 *  same name must not collide. Matches the tuple the server persists. */
export function favoriteKey(id: {
  kind: ArsenalKind;
  scope: ArsenalScope;
  source?: string;
  name: string;
}): string {
  return `${id.kind}|${id.scope}|${id.source ?? ""}|${id.name}`;
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
    case "favorites":
      return "var(--c-opus)"; // warm red — reads as a heart
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

// `all` and `favorites` never reach this sort — both rows are placed by hand at
// the top of the returned array. They're listed only to satisfy the Record type.
const KIND_ORDER: Record<ArsenalGroupKind, number> = {
  all: -1,
  favorites: -1,
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
 * Build the group panel's rows: "All", then "Favorites" when there are any,
 * then project / personal, then packs, then one row per plugin alphabetically.
 * Only non-empty groups are returned, so a filtered-to-nothing plugin simply
 * disappears from the panel.
 *
 * Two kinds of row, and the difference matters:
 *   - PARTITION rows (project | personal | pack:* | plugin:*) — every item lands
 *     in exactly one of them, so `All` is their union and its count is their sum.
 *   - CROSS-CUT rows (`Favorites`) — a subset of `All` whose items ALSO appear in
 *     their home partition row. Favoriting a personal skill doesn't move it out
 *     of `Personal`. So `Favorites ⊆ All`, and it must be excluded from any
 *     "does All equal the sum of the rows" check.
 *
 * `opts.favorites` holds `favoriteKey()` strings; `opts.kind` is the active tab,
 * needed because that key includes the kind and because MCP items are never
 * favoritable.
 */
export function buildGroups(
  items: ArsenalItem[],
  opts: { kind?: ArsenalKind; favorites?: ReadonlySet<string> } = {},
): ArsenalGroup[] {
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

  // MCP is excluded here, in the tested function, rather than by the UI simply
  // not offering hearts — otherwise a hand-edited `mcp` entry in favorites.json
  // would materialize this row on the MCP tab.
  const favorites =
    opts.kind && opts.kind !== "mcp" && opts.favorites?.size
      ? items.filter((it) =>
          opts.favorites?.has(favoriteKey({ ...it, kind: opts.kind as ArsenalKind })),
        )
      : [];

  return [
    { key: GROUP_ALL, label: "All", scope: "all", items },
    // Omitted entirely when empty, so a no-favorites panel is identical to
    // before this feature existed — including its dividers.
    ...(favorites.length
      ? [
          {
            key: GROUP_FAVORITES,
            label: "Favorites",
            scope: "favorites" as const,
            items: favorites,
          },
        ]
      : []),
    ...rest,
  ];
}

/** Visual bands in the group panel: [All + Favorites + own scopes] | [packs] |
 *  [plugins]. A divider is drawn wherever the band changes — so Favorites, being
 *  in the first band, adds no divider of its own. */
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
