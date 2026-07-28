// The Arsenal browser's grouping model (v0.22). Pure, so the two-pane UI has
// real coverage even though the dashboard has no component-test harness.

import { describe, it, expect } from "vitest";

import type { ArsenalItem } from "../src/dashboard/arsenal.js";
import {
  buildGroups,
  favoriteKey,
  filterItems,
  GROUP_ALL,
  GROUP_FAVORITES,
  itemBadge,
  itemKey,
  itemKind,
  itemsForSelection,
  prettyPluginLabel,
  resolveSelection,
  scopeColor,
  startsNewBand,
} from "../src/dashboard/ui/lib/arsenal-groups.js";

function item(over: Partial<ArsenalItem> & { name: string }): ArsenalItem {
  return { description: "", scope: "personal", ...over };
}

/** A pack: the parent SKILL.md item plus two expanded command members. */
const PACK_ITEMS: ArsenalItem[] = [
  item({ name: "dogfood", description: "log a session" }),
  item({ name: "impeccable adapt", pack: "impeccable", pack_command: "adapt" }),
  item({ name: "impeccable", pack: "impeccable", description: "the design language" }),
  item({ name: "impeccable polish", pack: "impeccable", pack_command: "polish" }),
  item({ name: "figma-use", scope: "plugin", source: "figma" }),
];

const ITEMS: ArsenalItem[] = [
  item({
    name: "ab-testing",
    scope: "plugin",
    source: "marketing-skills",
    description: "split tests",
  }),
  item({ name: "ads", scope: "plugin", source: "marketing-skills" }),
  item({ name: "svelte-code-writer", scope: "plugin", source: "svelte" }),
  item({ name: "dogfood", scope: "personal", description: "log a session" }),
  item({ name: "project-skill", scope: "project" }),
  item({ name: "figma-use", scope: "plugin", source: "figma" }),
];

describe("prettyPluginLabel", () => {
  it("title-cases kebab and snake plugin names", () => {
    expect(prettyPluginLabel("marketing-skills")).toBe("Marketing Skills");
    expect(prettyPluginLabel("voltagent-core-dev")).toBe("Voltagent Core Dev");
    expect(prettyPluginLabel("figma")).toBe("Figma");
    expect(prettyPluginLabel("skill_creator")).toBe("Skill Creator");
  });

  it("keeps acronyms uppercase", () => {
    expect(prettyPluginLabel("voltagent-data-ai")).toBe("Voltagent Data AI");
    expect(prettyPluginLabel("voltagent-qa-sec")).toBe("Voltagent QA Sec");
    expect(prettyPluginLabel("ui-kit")).toBe("UI Kit");
  });
});

describe("buildGroups", () => {
  it("puts All first, then project, personal, then plugins alphabetically", () => {
    const g = buildGroups(ITEMS);
    expect(g.map((x) => x.key)).toEqual([
      GROUP_ALL,
      "project",
      "personal",
      "plugin:figma",
      "plugin:marketing-skills",
      "plugin:svelte",
    ]);
    expect(g.map((x) => x.label)).toEqual([
      "All",
      "In this project",
      "Personal",
      "Figma",
      "Marketing Skills",
      "Svelte",
    ]);
  });

  it("counts items per group, with All holding everything", () => {
    const g = buildGroups(ITEMS);
    const byKey = Object.fromEntries(g.map((x) => [x.key, x.items.length]));
    expect(byKey[GROUP_ALL]).toBe(6);
    expect(byKey["plugin:marketing-skills"]).toBe(2);
    expect(byKey["plugin:svelte"]).toBe(1);
    expect(byKey.project).toBe(1);
    expect(byKey.personal).toBe(1);
  });

  it("returns only the All row for an empty arsenal", () => {
    const g = buildGroups([]);
    expect(g).toHaveLength(1);
    expect(g[0]?.key).toBe(GROUP_ALL);
    expect(g[0]?.items).toEqual([]);
  });

  it("falls back to a 'plugin' label when a plugin item has no source", () => {
    const g = buildGroups([item({ name: "orphan", scope: "plugin" })]);
    expect(g[1]?.key).toBe("plugin:plugin");
    expect(g[1]?.label).toBe("Plugin");
  });
});

describe("filterItems", () => {
  it("matches name, description, or plugin source", () => {
    expect(filterItems(ITEMS, "ab-test").map((i) => i.name)).toEqual(["ab-testing"]);
    expect(filterItems(ITEMS, "log a session").map((i) => i.name)).toEqual(["dogfood"]);
    // source match pulls in the whole plugin
    expect(filterItems(ITEMS, "marketing").map((i) => i.name)).toEqual(["ab-testing", "ads"]);
  });

  it("is case-insensitive, trims, and passes everything through when empty", () => {
    expect(filterItems(ITEMS, "  FIGMA ").map((i) => i.name)).toEqual(["figma-use"]);
    expect(filterItems(ITEMS, "")).toHaveLength(ITEMS.length);
    expect(filterItems(ITEMS, "   ")).toHaveLength(ITEMS.length);
  });

  it("filtering can empty a group so it disappears from the panel", () => {
    const g = buildGroups(filterItems(ITEMS, "marketing"));
    expect(g.map((x) => x.key)).toEqual([GROUP_ALL, "plugin:marketing-skills"]);
  });
});

describe("resolveSelection / itemsForSelection", () => {
  const groups = buildGroups(ITEMS);

  it("keeps a selection that still exists", () => {
    expect(resolveSelection(groups, "plugin:svelte")).toBe("plugin:svelte");
  });

  it("falls back to All when the group is gone (tab switch, rescan, filter)", () => {
    expect(resolveSelection(groups, "plugin:vanished")).toBe(GROUP_ALL);
    // e.g. a plugin with skills but no agents
    const agentGroups = buildGroups([item({ name: "only-agent", scope: "personal" })]);
    expect(resolveSelection(agentGroups, "plugin:marketing-skills")).toBe(GROUP_ALL);
  });

  it("returns the selected group's items, or everything for All", () => {
    expect(itemsForSelection(groups, "plugin:marketing-skills").map((i) => i.name)).toEqual([
      "ab-testing",
      "ads",
    ]);
    expect(itemsForSelection(groups, GROUP_ALL)).toHaveLength(6);
    expect(itemsForSelection(groups, "plugin:nope")).toEqual([]);
  });
});

describe("pack groups", () => {
  it("gives a pack its own row between personal and the plugins", () => {
    const g = buildGroups(PACK_ITEMS);
    expect(g.map((x) => x.key)).toEqual([GROUP_ALL, "personal", "pack:impeccable", "plugin:figma"]);
    expect(g.map((x) => x.label)).toEqual(["All", "Personal", "Impeccable", "Figma"]);
  });

  it("keeps pack members out of Personal so the counts stay honest", () => {
    const g = buildGroups(PACK_ITEMS);
    const byKey = Object.fromEntries(g.map((x) => [x.key, x.items.length]));
    expect(byKey.personal).toBe(1); // dogfood only
    expect(byKey["pack:impeccable"]).toBe(3);
    // All equals the sum of the PARTITION rows. Favorites is a cross-cut — its
    // items are counted in their home rows too — so it never joins this sum.
    const rest = g
      .slice(1)
      .filter((x) => x.scope !== "favorites")
      .reduce((n, x) => n + x.items.length, 0);
    expect(byKey[GROUP_ALL]).toBe(rest);
  });

  it("hoists the pack's own skill to the top of its row", () => {
    const g = buildGroups(PACK_ITEMS);
    const pack = g.find((x) => x.key === "pack:impeccable");
    expect(pack?.items.map((i) => i.name)).toEqual([
      "impeccable",
      "impeccable adapt",
      "impeccable polish",
    ]);
  });

  it("sorts multiple packs alphabetically, all after personal", () => {
    const g = buildGroups([
      ...PACK_ITEMS,
      item({ name: "aurora glow", pack: "aurora", pack_command: "glow" }),
    ]);
    expect(g.map((x) => x.key)).toEqual([
      GROUP_ALL,
      "personal",
      "pack:aurora",
      "pack:impeccable",
      "plugin:figma",
    ]);
  });

  it("groups by pack even when the item came from a plugin", () => {
    const g = buildGroups([
      item({ name: "p x", scope: "plugin", source: "vendor", pack: "p", pack_command: "x" }),
    ]);
    expect(g[1]?.key).toBe("pack:p");
    expect(g[1]?.scope).toBe("pack");
  });

  it("finds a whole pack by its name and one command by its own", () => {
    expect(filterItems(PACK_ITEMS, "impeccable").map((i) => i.name)).toEqual([
      "impeccable adapt",
      "impeccable",
      "impeccable polish",
    ]);
    expect(filterItems(PACK_ITEMS, "polish").map((i) => i.name)).toEqual(["impeccable polish"]);
    expect(filterItems(PACK_ITEMS, "  IMPECCABLE ")).toHaveLength(3);
  });

  it("collapses the panel to the pack row when filtered to it", () => {
    const g = buildGroups(filterItems(PACK_ITEMS, "impeccable"));
    expect(g.map((x) => x.key)).toEqual([GROUP_ALL, "pack:impeccable"]);
  });

  it("keeps a pack selection, falling back to All on a tab without it", () => {
    const groups = buildGroups(PACK_ITEMS);
    expect(resolveSelection(groups, "pack:impeccable")).toBe("pack:impeccable");
    // packs are skills-only — the Agents tab has no such row
    const agents = buildGroups([item({ name: "release-manager", scope: "project" })]);
    expect(resolveSelection(agents, "pack:impeccable")).toBe(GROUP_ALL);
  });
});

describe("startsNewBand", () => {
  it("draws one divider before the packs and one before the plugins", () => {
    const g = buildGroups(PACK_ITEMS); // all, personal, pack:impeccable, plugin:figma
    expect(startsNewBand(g, 0)).toBe(false);
    expect(startsNewBand(g, 1)).toBe(false); // all → personal, same band
    expect(startsNewBand(g, 2)).toBe(true); // personal → pack
    expect(startsNewBand(g, 3)).toBe(true); // pack → plugin
  });

  it("does not divide between two rows of the same band", () => {
    const g = buildGroups([
      ...PACK_ITEMS,
      item({ name: "aurora glow", pack: "aurora", pack_command: "glow" }),
      item({ name: "other", scope: "plugin", source: "zed" }),
    ]);
    const keys = g.map((x) => x.key);
    expect(startsNewBand(g, keys.indexOf("pack:impeccable"))).toBe(false); // aurora → impeccable
    expect(startsNewBand(g, keys.indexOf("plugin:zed"))).toBe(false); // figma → zed
  });

  // Regression: with no packs the panel must render exactly as it did in v0.22.
  it("matches the pre-pack behavior when no pack exists", () => {
    const g = buildGroups(ITEMS); // all, project, personal, 3 plugins
    expect(g.map((_, i) => startsNewBand(g, i))).toEqual([false, false, false, true, false, false]);
  });
});

describe("itemKey / itemKind / itemBadge / scopeColor", () => {
  it("separates key parts so concatenation can't collide", () => {
    const a = item({ name: "b-c", scope: "plugin", source: "a" });
    const b = item({ name: "c", scope: "plugin", source: "a-b" });
    expect(itemKey(a)).not.toBe(itemKey(b));
  });

  // Within one tab every item must key uniquely, or Svelte throws on the
  // {#each}. (ITEMS and PACK_ITEMS intentionally overlap, so they're separate.)
  it("is unique within a tab's item list", () => {
    expect(new Set(ITEMS.map(itemKey)).size).toBe(ITEMS.length);
    expect(new Set(PACK_ITEMS.map(itemKey)).size).toBe(PACK_ITEMS.length);
  });

  it("reports pack ahead of plugin ahead of scope", () => {
    expect(itemKind(item({ name: "x", pack: "p", scope: "plugin", source: "v" }))).toBe("pack");
    expect(itemKind(item({ name: "x", scope: "plugin", source: "v" }))).toBe("plugin");
    expect(itemKind(item({ name: "x", scope: "project" }))).toBe("project");
    expect(itemBadge(item({ name: "x", pack: "p", scope: "plugin", source: "v" }))).toBe("p");
    expect(itemBadge(item({ name: "x", scope: "plugin", source: "v" }))).toBe("v");
    expect(itemBadge(item({ name: "x", scope: "plugin" }))).toBe("plugin");
    expect(itemBadge(item({ name: "x", scope: "personal" }))).toBe("personal");
  });

  it("gives every kind its own color", () => {
    const colors = ["all", "project", "personal", "pack", "plugin", "favorites"].map(scopeColor);
    expect(new Set(colors).size).toBe(6);
    expect(scopeColor("pack")).toBe("var(--c-haiku)");
    expect(scopeColor("favorites")).toBe("var(--c-opus)");
  });
});

describe("favorites row", () => {
  const skillFav = favoriteKey({ kind: "skills", scope: "personal", name: "dogfood" });
  const packFav = favoriteKey({ kind: "skills", scope: "personal", name: "impeccable polish" });
  const pluginFav = favoriteKey({
    kind: "skills",
    scope: "plugin",
    source: "figma",
    name: "figma-use",
  });

  // Regression: the panel must look exactly as it did before this feature for
  // anyone who has never favorited anything.
  it("adds nothing when there are no favorites", () => {
    expect(buildGroups(PACK_ITEMS, {})).toEqual(buildGroups(PACK_ITEMS));
    expect(buildGroups(PACK_ITEMS, { kind: "skills", favorites: new Set() })).toEqual(
      buildGroups(PACK_ITEMS),
    );
    expect(buildGroups(PACK_ITEMS).some((g) => g.key === GROUP_FAVORITES)).toBe(false);
  });

  it("sits directly under All, with its own key, label, and kind", () => {
    const g = buildGroups(PACK_ITEMS, { kind: "skills", favorites: new Set([skillFav]) });
    expect(g[0]?.key).toBe(GROUP_ALL);
    expect(g[1]?.key).toBe(GROUP_FAVORITES);
    expect(g[1]?.label).toBe("Favorites");
    expect(g[1]?.scope).toBe("favorites");
    expect(g[1]?.items.map((i) => i.name)).toEqual(["dogfood"]);
  });

  it("is a cross-cut: a favorite stays in its home row too", () => {
    const g = buildGroups(PACK_ITEMS, { kind: "skills", favorites: new Set([skillFav, packFav]) });
    const byKey = Object.fromEntries(g.map((x) => [x.key, x.items.map((i) => i.name)]));
    expect(byKey[GROUP_FAVORITES]).toEqual(["dogfood", "impeccable polish"]);
    expect(byKey.personal).toContain("dogfood"); // not moved out
    expect(byKey["pack:impeccable"]).toContain("impeccable polish");
  });

  it("keeps All as the sum of the partition rows, with Favorites a subset of All", () => {
    const g = buildGroups(PACK_ITEMS, { kind: "skills", favorites: new Set([skillFav, packFav]) });
    const all = g[0]?.items ?? [];
    const partitions = g.filter((x) => x.key !== GROUP_ALL && x.scope !== "favorites");
    expect(partitions.reduce((n, x) => n + x.items.length, 0)).toBe(all.length);
    const favs = g.find((x) => x.key === GROUP_FAVORITES)?.items ?? [];
    expect(favs.every((f) => all.includes(f))).toBe(true);
  });

  it("never appears on the MCP tab, even if the file names an mcp item", () => {
    const mcpItems = [item({ name: "figma", scope: "plugin", source: "figma" })];
    const favorites = new Set([
      favoriteKey({ kind: "mcp", scope: "plugin", source: "figma", name: "figma" }),
    ]);
    const g = buildGroups(mcpItems, { kind: "mcp", favorites });
    expect(g.some((x) => x.key === GROUP_FAVORITES)).toBe(false);
  });

  it("needs the kind, since the key is kind-scoped", () => {
    // the same identity favorited as a skill must not light up the agents tab
    const g = buildGroups(PACK_ITEMS, { kind: "agents", favorites: new Set([skillFav]) });
    expect(g.some((x) => x.key === GROUP_FAVORITES)).toBe(false);
  });

  it("disappears when the filter excludes every favorite", () => {
    const opts = { kind: "skills" as const, favorites: new Set([skillFav]) };
    expect(buildGroups(filterItems(PACK_ITEMS, "dogfood"), opts)[1]?.key).toBe(GROUP_FAVORITES);
    expect(
      buildGroups(filterItems(PACK_ITEMS, "impeccable"), opts).some(
        (x) => x.key === GROUP_FAVORITES,
      ),
    ).toBe(false);
  });

  it("follows the item order, not the order things were favorited", () => {
    // set built in reverse of the item order
    const favorites = new Set([pluginFav, packFav, skillFav]);
    const items = [...PACK_ITEMS, item({ name: "figma-use", scope: "plugin", source: "figma" })];
    const g = buildGroups(items, { kind: "skills", favorites });
    const favRow = g.find((x) => x.key === GROUP_FAVORITES)?.items.map((i) => i.name);
    const allOrder = (g[0]?.items ?? []).map((i) => i.name).filter((n) => favRow?.includes(n));
    expect(favRow).toEqual(allOrder);
  });

  // Inside its own row the pack's parent is hoisted to the top. Favorites is
  // not that row: a favorited member has no special relationship to its parent
  // there, so item order wins. PACK_ITEMS lists "impeccable adapt" BEFORE
  // "impeccable", which is what makes this assertion meaningful.
  it("does not hoist a pack parent inside Favorites", () => {
    const parentFav = favoriteKey({ kind: "skills", scope: "personal", name: "impeccable" });
    const adaptFav = favoriteKey({ kind: "skills", scope: "personal", name: "impeccable adapt" });
    const g = buildGroups(PACK_ITEMS, {
      kind: "skills",
      favorites: new Set([adaptFav, parentFav]),
    });
    expect(g.find((x) => x.key === GROUP_FAVORITES)?.items.map((i) => i.name)).toEqual([
      "impeccable adapt",
      "impeccable",
    ]);
    // ...whereas the pack's own row still leads with the parent
    expect(g.find((x) => x.key === "pack:impeccable")?.items[0]?.name).toBe("impeccable");
  });

  it("draws no new divider around the Favorites row", () => {
    const g = buildGroups(PACK_ITEMS, { kind: "skills", favorites: new Set([skillFav]) });
    // all, favorites, personal, pack:impeccable, plugin:figma
    expect(g.map((_, i) => startsNewBand(g, i))).toEqual([false, false, false, true, true]);
  });

  it("keeps a Favorites selection while it exists, else falls back to All", () => {
    const withRow = buildGroups(PACK_ITEMS, { kind: "skills", favorites: new Set([skillFav]) });
    expect(resolveSelection(withRow, GROUP_FAVORITES)).toBe(GROUP_FAVORITES);
    // unfavoriting the last one removes the row — selection must not dangle
    const without = buildGroups(PACK_ITEMS, { kind: "skills", favorites: new Set() });
    expect(resolveSelection(without, GROUP_FAVORITES)).toBe(GROUP_ALL);
  });

  it("keys favorites distinctly across kind, scope, and source", () => {
    const keys = [
      favoriteKey({ kind: "skills", scope: "personal", name: "x" }),
      favoriteKey({ kind: "agents", scope: "personal", name: "x" }),
      favoriteKey({ kind: "skills", scope: "project", name: "x" }),
      favoriteKey({ kind: "skills", scope: "plugin", source: "a", name: "x" }),
      favoriteKey({ kind: "skills", scope: "plugin", source: "b", name: "x" }),
    ];
    expect(new Set(keys).size).toBe(5);
    // an item without a source must key the same as one with an empty source
    expect(favoriteKey({ kind: "skills", scope: "personal", name: "x" })).toBe(
      favoriteKey({ kind: "skills", scope: "personal", source: "", name: "x" }),
    );
  });
});
