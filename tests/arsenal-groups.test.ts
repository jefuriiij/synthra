// The Arsenal browser's grouping model (v0.22). Pure, so the two-pane UI has
// real coverage even though the dashboard has no component-test harness.

import { describe, it, expect } from "vitest";

import type { ArsenalItem } from "../src/dashboard/arsenal.js";
import {
  buildGroups,
  filterItems,
  GROUP_ALL,
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
    // All still equals the sum of the other rows
    const rest = g.slice(1).reduce((n, x) => n + x.items.length, 0);
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
    const colors = ["all", "project", "personal", "pack", "plugin"].map(scopeColor);
    expect(new Set(colors).size).toBe(5);
    expect(scopeColor("pack")).toBe("var(--c-haiku)");
  });
});
