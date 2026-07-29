// Display helpers behind the Arsenal detail modal. Pure, so the modal's logic
// has coverage even though the dashboard has no component-test harness.

import { describe, it, expect } from "vitest";

import type { ArsenalDetail, ArsenalItem } from "../src/dashboard/arsenal.js";
import {
  bodyStats,
  detailKey,
  detailRows,
  detailSubtitle,
  frontmatterRows,
  skillInvocation,
} from "../src/dashboard/ui/lib/arsenal-detail.js";

function item(over: Partial<ArsenalItem> & { name: string }): ArsenalItem {
  return { description: "", scope: "personal", ...over };
}

function detail(over: Partial<ArsenalDetail> = {}): ArsenalDetail {
  return {
    kind: "skills",
    name: "impeccable",
    scope: "personal",
    description: "",
    truncated: false,
    ...over,
  };
}

describe("detailKey", () => {
  it("distinguishes the same name across tabs", () => {
    const it1 = item({ name: "twin" });
    expect(detailKey("skills", it1)).not.toBe(detailKey("agents", it1));
  });

  it("distinguishes scope and plugin source", () => {
    const personal = item({ name: "figma-use" });
    const plugin = item({ name: "figma-use", scope: "plugin", source: "figma" });
    expect(detailKey("skills", personal)).not.toBe(detailKey("skills", plugin));
  });
});

describe("frontmatterRows", () => {
  it("leads with the keys worth reading first, then declaration order", () => {
    const rows = frontmatterRows({
      "metadata.author": "jeff",
      license: "MIT",
      version: "4.0.2",
    });
    expect(rows.map(([k]) => k)).toEqual(["version", "license", "metadata.author"]);
  });

  // The header already shows the title and the description paragraph; repeating
  // them as rows pushed the source below the fold.
  it("omits name and description, which the header owns", () => {
    const rows = frontmatterRows({ name: "n", description: "d", version: "1" });
    expect(rows.map(([k]) => k)).toEqual(["version"]);
  });

  it("drops empty values and keeps keys verbatim", () => {
    const rows = frontmatterRows({ license: "MIT", model: "   ", "argument-hint": "[target]" });
    expect(rows.map(([k]) => k)).toEqual(["argument-hint", "license"]);
  });

  it("returns [] for empty or missing frontmatter", () => {
    expect(frontmatterRows({})).toEqual([]);
    expect(frontmatterRows(undefined)).toEqual([]);
  });
});

describe("detailRows", () => {
  it("prefers frontmatter when the item has a file", () => {
    const rows = detailRows(
      detail({ frontmatter: { version: "4.0.2" }, meta: { argument_hint: "[target]" } }),
    );
    expect(rows).toEqual([["version", "4.0.2"]]);
  });

  // MCP entries have no file, so meta (type/url) is all there is — it used to
  // be visible on the expanding card and must not vanish with the modal.
  it("falls back to meta when there is no frontmatter", () => {
    const rows = detailRows(
      detail({ kind: "mcp", meta: { type: "http", url: "https://x.example/mcp" } }),
    );
    expect(rows).toEqual([
      ["type", "http"],
      ["url", "https://x.example/mcp"],
    ]);
  });

  it("returns [] with nothing to show", () => {
    expect(detailRows(detail())).toEqual([]);
    expect(detailRows(null)).toEqual([]);
  });
});

describe("skillInvocation", () => {
  it("uses the pinned shortcut when a pack pinned one", () => {
    const member = item({
      name: "impeccable audit",
      pack: "impeccable",
      pack_command: "audit",
      pinned_as: "/audit",
    });
    expect(skillInvocation(member, "skills")).toBe("/audit");
  });

  it("falls back to the pack form for an un-pinned member", () => {
    const member = item({ name: "impeccable audit", pack: "impeccable", pack_command: "audit" });
    expect(skillInvocation(member, "skills")).toBe("/impeccable audit");
  });

  it("prefixes a plugin skill with its plugin", () => {
    const plug = item({ name: "seo-audit", scope: "plugin", source: "marketing-skills" });
    expect(skillInvocation(plug, "skills")).toBe("/marketing-skills:seo-audit");
  });

  it("uses the bare name for a project or personal skill, and for a pack's own skill", () => {
    expect(skillInvocation(item({ name: "dogfood" }), "skills")).toBe("/dogfood");
    expect(skillInvocation(item({ name: "rel", scope: "project" }), "skills")).toBe("/rel");
    // the parent carries `pack` but no `pack_command` — it IS a real skill
    expect(skillInvocation(item({ name: "impeccable", pack: "impeccable" }), "skills")).toBe(
      "/impeccable",
    );
  });

  it("says nothing for a skill that opted out of the slash menu", () => {
    expect(skillInvocation(item({ name: "shadcn-svelte", invocable: false }), "skills")).toBeNull();
    // ...even when it would otherwise have had a form
    const plug = item({ name: "x", scope: "plugin", source: "p", invocable: false });
    expect(skillInvocation(plug, "skills")).toBeNull();
  });

  it("says nothing for agents or MCP servers", () => {
    expect(skillInvocation(item({ name: "release-manager" }), "agents")).toBeNull();
    expect(
      skillInvocation(item({ name: "figma", scope: "plugin", source: "figma" }), "mcp"),
    ).toBeNull();
  });
});

describe("detailSubtitle", () => {
  it("shows scope, kind, size, and path for a personal skill", () => {
    const s = detailSubtitle(
      item({ name: "long-skill" }),
      detail({ body_chars: 12_698, path: "~/.claude/skills/long/SKILL.md" }),
    );
    expect(s).toBe("personal · skill · 12.4 KB · ~/.claude/skills/long/SKILL.md");
  });

  it("names the plugin for plugin items and the pack for pack members", () => {
    const plugin = detailSubtitle(
      item({ name: "figma-use", scope: "plugin", source: "figma" }),
      detail({ kind: "skills", scope: "plugin", source: "figma" }),
    );
    expect(plugin.startsWith("plugin figma · skill")).toBe(true);
    const member = detailSubtitle(
      item({ name: "impeccable polish", pack: "impeccable", pack_command: "polish" }),
      detail({ pack: "impeccable", pack_command: "polish" }),
    );
    expect(member.startsWith("impeccable · skill")).toBe(true);
  });

  it("omits size and path for an MCP entry, and works before the fetch lands", () => {
    const mcp = item({ name: "myserver", scope: "project" });
    expect(detailSubtitle(mcp, detail({ kind: "mcp", scope: "project" }))).toBe(
      "project · mcp server",
    );
    expect(detailSubtitle(mcp, null)).toBe("project");
  });
});

describe("bodyStats", () => {
  it("counts lines without a phantom trailing one", () => {
    expect(bodyStats("a\nb\nc\n")).toEqual({ lines: 3, chars: 6 });
    expect(bodyStats("a\nb\nc")).toEqual({ lines: 3, chars: 5 });
  });

  it("treats CRLF the same as LF", () => {
    expect(bodyStats("a\r\nb\r\n").lines).toBe(2);
  });

  it("handles empty and missing bodies", () => {
    expect(bodyStats("")).toEqual({ lines: 0, chars: 0 });
    expect(bodyStats(undefined)).toEqual({ lines: 0, chars: 0 });
    expect(bodyStats("\n")).toEqual({ lines: 0, chars: 1 });
  });
});
