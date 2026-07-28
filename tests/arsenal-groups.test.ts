// The Arsenal browser's grouping model (v0.22). Pure, so the two-pane UI has
// real coverage even though the dashboard has no component-test harness.

import { describe, it, expect } from "vitest";

import type { ArsenalItem } from "../src/dashboard/arsenal.js";
import {
  buildGroups,
  filterItems,
  GROUP_ALL,
  itemsForSelection,
  prettyPluginLabel,
  resolveSelection,
} from "../src/dashboard/ui/lib/arsenal-groups.js";

function item(over: Partial<ArsenalItem> & { name: string }): ArsenalItem {
  return { description: "", scope: "personal", ...over };
}

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
