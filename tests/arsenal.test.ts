// Arsenal scanner — reads Claude Code's on-disk skills/agents/MCP across
// project, personal (~/.claude), and plugin scopes. computeArsenal takes an
// injectable homeDir so we can point it at a temp fake-home.

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  computeArsenal,
  computeArsenalDetail,
  parseFrontmatter,
  readFrontmatter,
} from "../src/dashboard/arsenal.js";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * An impeccable-shaped command pack under `<home>/.claude/skills/impeccable`.
 * The manifest is the authority for membership, so this deliberately ships a
 * `ghost` key with no reference file plus two reference files the manifest
 * never names (`hooks`, `adapt.native`) — none of the three may become items.
 * Pass `manifest: null` to omit the manifest entirely.
 */
async function writePack(home: string, manifest?: string | null): Promise<string> {
  const dir = join(home, ".claude", "skills", "impeccable");
  await write(
    join(dir, "SKILL.md"),
    '---\nname: impeccable\ndescription: The design language.\nmetadata:\n  version: "4.0.2"\n---\n# Impeccable\n\nProse body.\n',
  );
  const json =
    manifest === undefined
      ? JSON.stringify({
          polish: {
            description: "Final quality pass before shipping.",
            argumentHint: "[target]",
          },
          adapt: { description: "Adapt across screen sizes." },
          ghost: { description: "Listed but has no reference file." },
        })
      : manifest;
  if (json !== null) await write(join(dir, "scripts", "command-metadata.json"), json);
  await write(join(dir, "reference", "polish.md"), "# Polish\n\nAlignment and spacing.\n");
  await write(join(dir, "reference", "adapt.md"), "# Adapt\n");
  await write(join(dir, "reference", "hooks.md"), "# Hooks (infra doc, not a command)\n");
  await write(join(dir, "reference", "adapt.native.md"), "# Adapt native\n");
  return dir;
}

describe("parseFrontmatter", () => {
  it("reads single-line keys", () => {
    const fm = parseFrontmatter("---\nname: demo\ndescription: A demo skill.\n---\nbody");
    expect(fm.name).toBe("demo");
    expect(fm.description).toBe("A demo skill.");
  });

  it("joins a quoted value that spans multiple lines", () => {
    const fm = parseFrontmatter(
      '---\nname: x\ndescription: "line one\nline two"\ntools: A, B\n---\n',
    );
    expect(fm.description).toBe("line one line two");
    expect(fm.tools).toBe("A, B");
  });

  it("leaves description absent when missing", () => {
    const fm = parseFrontmatter("---\nname: y\n---\n");
    expect(fm.name).toBe("y");
    expect(fm.description).toBeUndefined();
  });

  it("ignores nested/indented keys (e.g. under metadata:)", () => {
    const fm = parseFrontmatter("---\nname: z\nmetadata:\n  model: gemini\n---\n");
    expect(fm.name).toBe("z");
    expect(fm.model).toBeUndefined();
  });

  it("returns {} when there is no frontmatter block", () => {
    expect(parseFrontmatter("# just markdown\n")).toEqual({});
  });

  // Regression: a `description: |` block used to yield the literal "|", which
  // put a bare pipe on the humanizer skill's card and gave the Dispatcher zero
  // description tokens for it.
  it("reads a block-scalar value instead of returning the pipe", () => {
    const fm = parseFrontmatter(
      "---\nname: humanizer\ndescription: |\n  Remove signs of AI writing.\n  Use when editing text.\nlicense: MIT\n---\nbody\n",
    );
    expect(fm.description).toBe("Remove signs of AI writing.\nUse when editing text.");
    expect(fm.license).toBe("MIT");
  });

  it("folds a `>` block scalar onto one line", () => {
    const fm = parseFrontmatter("---\ndescription: >\n  folded over\n  two lines\n---\n");
    expect(fm.description).toBe("folded over two lines");
  });
});

describe("readFrontmatter", () => {
  it("exposes nested keys as dotted paths that parseFrontmatter hides", () => {
    const md = '---\nname: humanizer\nmetadata:\n  version: "2.9.1"\n  model: gemini\n---\n';
    expect(readFrontmatter(md).fm["metadata.version"]).toBe("2.9.1");
    expect(readFrontmatter(md).fm["metadata.model"]).toBe("gemini");
    // the legacy shape stays top-level-only
    expect(parseFrontmatter(md).version).toBeUndefined();
    expect(parseFrontmatter(md).model).toBeUndefined();
  });

  it("joins a block sequence with commas", () => {
    const fm = readFrontmatter("---\nallowed-tools:\n  - Read\n  - Write\n---\n").fm;
    expect(fm["allowed-tools"]).toBe("Read, Write");
  });

  it("splits the body off after the closing ---", () => {
    const r = readFrontmatter("---\nname: x\n---\n# Heading\n\nProse.\n");
    expect(r.body).toBe("# Heading\n\nProse.\n");
    expect(r.fm.name).toBe("x");
  });

  it("returns the whole document as body when there is no frontmatter", () => {
    const r = readFrontmatter("# just markdown\n");
    expect(r.fm).toEqual({});
    expect(r.body).toBe("# just markdown\n");
  });
});

describe("computeArsenal", () => {
  async function fixture(): Promise<{ home: string; proj: string }> {
    const home = await mkdtemp(join(tmpdir(), "syn-arsenal-home-"));
    const proj = await mkdtemp(join(tmpdir(), "syn-arsenal-proj-"));

    // personal skill
    await write(
      join(home, ".claude", "skills", "demo", "SKILL.md"),
      '---\nname: demo-skill\ndescription: A personal demo skill.\nuser-invocable: true\nargument-hint: "[path]"\n---\nbody\n',
    );
    // project agent
    await write(
      join(proj, ".claude", "agents", "rel.md"),
      '---\nname: "release-manager"\ndescription: "Coordinate releases."\ntools: Read, Edit, Bash\nmodel: sonnet\n---\n',
    );
    // project MCP (no secrets)
    await write(
      join(proj, ".mcp.json"),
      JSON.stringify({
        mcpServers: { synthra: { type: "http", url: "http://127.0.0.1:8080/mcp" } },
      }),
    );

    // a plugin: index → installPath, with skill + agent + mcp (mcp carries a token)
    const pluginRoot = join(home, ".claude", "plugins", "cache", "mkt", "myplug", "1.0.0");
    await write(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "myplug@mkt": [{ scope: "user", installPath: pluginRoot, version: "1.0.0" }] },
      }),
    );
    await write(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "myplug@mkt": true } }),
    );
    // plugin.json lists a root-level agent (voltagent-style layout) — must be
    // found via the manifest even though it's NOT under agents/.
    await write(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "myplug", agents: ["./root-agent.md"] }),
    );
    await write(
      join(pluginRoot, "root-agent.md"),
      "---\nname: root-agent\ndescription: Lives at plugin root, listed in plugin.json.\n---\n",
    );
    await write(
      join(pluginRoot, "skills", "x", "SKILL.md"),
      "---\nname: plug-skill\ndescription: From a plugin.\n---\n",
    );
    // and a subdir-style agent (feature-dev layout) — must be found via agents/
    await write(
      join(pluginRoot, "agents", "y.md"),
      "---\nname: plug-agent\ndescription: Plugin agent.\nmodel: opus\n---\n",
    );
    await write(
      join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          myserver: {
            type: "http",
            url: "https://x.example/mcp?token=abc",
            headers: { Authorization: "Bearer SECRETTOKEN123" },
          },
        },
      }),
    );
    // a malformed skill — must be skipped, not throw
    await write(
      join(home, ".claude", "skills", "broken", "SKILL.md"),
      "not valid frontmatter at all",
    );
    // opted out of being a slash command — Claude loads it on its own
    await write(
      join(home, ".claude", "skills", "auto-only", "SKILL.md"),
      "---\nname: auto-only\ndescription: Model-invoked only.\nuser-invocable: false\n---\nbody\n",
    );

    await writePack(home);

    return { home, proj };
  }

  it("collects skills/agents/mcp across project, personal, and plugin scopes", async () => {
    const { home, proj } = await fixture();
    const a = await computeArsenal(proj, home);

    const skill = a.skills.find((s) => s.name === "demo-skill");
    expect(skill?.scope).toBe("personal");
    const plugSkill = a.skills.find((s) => s.name === "plug-skill");
    expect(plugSkill?.scope).toBe("plugin");
    expect(plugSkill?.source).toBe("myplug");
    expect(plugSkill?.enabled).toBe(true);

    const agent = a.agents.find((x) => x.name === "release-manager");
    expect(agent?.scope).toBe("project");
    expect(agent?.meta?.tools).toContain("Read");
    expect(agent?.meta?.model).toBe("sonnet");

    // both plugin-agent layouts resolve: agents/ subdir AND plugin.json root manifest
    expect(a.agents.some((x) => x.name === "plug-agent" && x.scope === "plugin")).toBe(true);
    expect(a.agents.some((x) => x.name === "root-agent" && x.scope === "plugin")).toBe(true);

    expect(a.mcp.find((m) => m.name === "synthra")?.scope).toBe("project");
    expect(a.mcp.find((m) => m.name === "myserver")?.scope).toBe("plugin");
    expect(a.counts.plugins).toBe(1);
  });

  it("redacts MCP secrets — never emits header tokens or url query", async () => {
    const { home, proj } = await fixture();
    const a = await computeArsenal(proj, home);
    const blob = JSON.stringify(a);
    expect(blob).not.toContain("SECRETTOKEN123");
    expect(blob).not.toContain("Bearer");
    expect(blob).not.toContain("token=abc");
    // the server is still listed, with its query-stripped url
    expect(a.mcp.find((m) => m.name === "myserver")?.meta?.url).toBe("https://x.example/mcp");
  });

  // Regression: `user-invocable` arrives as a STRING, so a truthiness test read
  // "false" as opting in — labelling the one skill that opted out as typeable.
  it("marks only an explicit user-invocable: false as not invocable", async () => {
    const { home, proj } = await fixture();
    const a = await computeArsenal(proj, home);
    expect(a.skills.find((s) => s.name === "auto-only")?.invocable).toBe(false);
    // declared true, and omitted entirely, both mean invocable — encoded as absence
    expect(a.skills.find((s) => s.name === "demo-skill")?.invocable).toBeUndefined();
    expect(a.skills.find((s) => s.name === "plug-skill")?.invocable).toBeUndefined();
    // the raw frontmatter string still reaches the client for display
    expect(a.skills.find((s) => s.name === "demo-skill")?.meta?.user_invocable).toBe("true");
  });

  it("does not throw on a malformed skill and skips nothing else", async () => {
    const { home, proj } = await fixture();
    const a = await computeArsenal(proj, home);
    // broken skill still yields an item (fallback name from dir), but never crashes
    expect(a.skills.some((s) => s.name === "demo-skill")).toBe(true);
  });
});

/** A pinned shortcut exactly as impeccable's pin.mjs writes one. */
async function writePin(home: string, pack: string, command: string): Promise<void> {
  await write(
    join(home, ".claude", "skills", command, "SKILL.md"),
    `---\nname: ${command}\ndescription: "Shortcut for /${pack} ${command}."\nargument-hint: "[target]"\nuser-invocable: true\n---\n\n<!-- ${pack}-pinned-skill -->\n\nThis is a pinned shortcut for \`/${pack} ${command}\`.\n`,
  );
}

describe("command pack expansion", () => {
  async function packFixture(manifest?: string | null): Promise<{ home: string; proj: string }> {
    const home = await mkdtemp(join(tmpdir(), "syn-pack-home-"));
    const proj = await mkdtemp(join(tmpdir(), "syn-pack-proj-"));
    await writePack(home, manifest);
    await write(join(home, ".claude", "skills", "plain", "SKILL.md"), "---\nname: plain\n---\n");
    return { home, proj };
  }

  it("expands manifest commands into namespaced members", async () => {
    const { home, proj } = await packFixture();
    const a = await computeArsenal(proj, home);

    const parent = a.skills.find((s) => s.name === "impeccable");
    expect(parent?.pack).toBe("impeccable");
    expect(parent?.pack_command).toBeUndefined();

    const polish = a.skills.find((s) => s.name === "impeccable polish");
    expect(polish?.pack).toBe("impeccable");
    expect(polish?.pack_command).toBe("polish");
    expect(polish?.scope).toBe("personal");
    expect(polish?.meta?.argument_hint).toBe("[target]");
    expect(a.skills.some((s) => s.name === "impeccable adapt")).toBe(true);
  });

  it("drops a manifest key with no reference file", async () => {
    const { home, proj } = await packFixture();
    const a = await computeArsenal(proj, home);
    expect(a.skills.some((s) => s.name === "impeccable ghost")).toBe(false);
  });

  it("never promotes un-listed reference files", async () => {
    const { home, proj } = await packFixture();
    const a = await computeArsenal(proj, home);
    expect(a.skills.some((s) => s.name === "impeccable hooks")).toBe(false);
    expect(a.skills.some((s) => s.name.includes("adapt.native"))).toBe(false);
  });

  it("counts pack members in counts.skills", async () => {
    const { home, proj } = await packFixture();
    const a = await computeArsenal(proj, home);
    expect(a.counts.skills).toBe(a.skills.length);
    expect(a.skills.filter((s) => s.pack_command).length).toBe(2);
  });

  it("sorts members directly after their parent", async () => {
    const { home, proj } = await packFixture();
    const a = await computeArsenal(proj, home);
    const names = a.skills.filter((s) => s.pack === "impeccable").map((s) => s.name);
    const start = a.skills.findIndex((s) => s.name === "impeccable");
    expect(a.skills.slice(start, start + names.length).map((s) => s.name)).toEqual([
      "impeccable",
      "impeccable adapt",
      "impeccable polish",
    ]);
  });

  it("clips a long member description to DESC_MAX", async () => {
    const { home, proj } = await packFixture(
      JSON.stringify({ polish: { description: "x".repeat(400) } }),
    );
    const a = await computeArsenal(proj, home);
    const polish = a.skills.find((s) => s.name === "impeccable polish");
    expect(polish?.description).toHaveLength(300);
    expect(polish?.description.endsWith("…")).toBe(true);
  });

  it("degrades to the parent alone when the manifest is missing", async () => {
    const { home, proj } = await packFixture(null);
    const a = await computeArsenal(proj, home);
    expect(a.skills.some((s) => s.name === "impeccable")).toBe(true);
    expect(a.skills.some((s) => s.pack_command)).toBe(false);
  });

  it("degrades to the parent alone when the manifest is corrupt", async () => {
    const { home, proj } = await packFixture("not json at all");
    const a = await computeArsenal(proj, home);
    expect(a.skills.some((s) => s.name === "impeccable")).toBe(true);
    expect(a.skills.some((s) => s.pack_command)).toBe(false);
  });

  it("leaves non-pack skills untouched", async () => {
    const { home, proj } = await packFixture(JSON.stringify({ polish: { description: "P." } }));
    const a = await computeArsenal(proj, home);
    const plain = a.skills.find((s) => s.name === "plain");
    expect(plain?.pack).toBeUndefined();
    expect(plain?.pack_command).toBeUndefined();
  });
});

describe("pinned pack shortcuts", () => {
  async function pinFixture(): Promise<{ home: string; proj: string }> {
    const home = await mkdtemp(join(tmpdir(), "syn-pin-home-"));
    const proj = await mkdtemp(join(tmpdir(), "syn-pin-proj-"));
    await writePack(home); // manifest: polish, adapt, ghost(no ref file)
    await writePin(home, "impeccable", "polish"); // member exists → merges
    await writePin(home, "nosuchpack", "orphan"); // pack absent → stays
    await write(join(home, ".claude", "skills", "plain", "SKILL.md"), "---\nname: plain\n---\n");
    return { home, proj };
  }

  it("folds a pin into its pack member instead of listing it twice", async () => {
    const { home, proj } = await pinFixture();
    const a = await computeArsenal(proj, home);
    const member = a.skills.find((s) => s.name === "impeccable polish");
    expect(member?.pinned_as).toBe("/polish");
    // the redirect file is represented by the member, not listed on its own
    expect(a.skills.some((s) => s.name === "polish")).toBe(false);
  });

  it("leaves un-pinned members without a shortcut", async () => {
    const { home, proj } = await pinFixture();
    const a = await computeArsenal(proj, home);
    expect(a.skills.find((s) => s.name === "impeccable adapt")?.pinned_as).toBeUndefined();
  });

  it("keeps an orphan pin as its own skill rather than dropping it", async () => {
    const { home, proj } = await pinFixture();
    const a = await computeArsenal(proj, home);
    const orphan = a.skills.find((s) => s.name === "orphan");
    expect(orphan).toBeDefined();
    expect(orphan?.pack).toBeUndefined(); // no pack to belong to
  });

  it("serves an orphan pin's own file from the detail endpoint", async () => {
    const { home, proj } = await pinFixture();
    const d = await computeArsenalDetail(
      proj,
      { kind: "skills", scope: "personal", name: "orphan" },
      home,
    );
    expect(d?.body).toContain("nosuchpack-pinned-skill");
  });

  it("counts a merged pin once, not twice", async () => {
    const { home, proj } = await pinFixture();
    const a = await computeArsenal(proj, home);
    expect(a.counts.skills).toBe(a.skills.length);
    // impeccable + 2 members + plain + orphan = 5; the merged `polish` is not extra
    expect(a.skills.map((s) => s.name).sort()).toEqual([
      "impeccable",
      "impeccable adapt",
      "impeccable polish",
      "orphan",
      "plain",
    ]);
  });

  // Detection is a substring match, so a skill that merely DOCUMENTS the
  // convention is read as a pin for a pack that doesn't exist. The orphan path
  // is what makes that harmless: it still appears, as itself, unmodified. The
  // residual risk is a doc skill whose name also collides with a real command
  // of a real installed pack — accepted as vanishingly unlikely.
  it("still lists a skill that merely mentions the marker in its body", async () => {
    const home = await mkdtemp(join(tmpdir(), "syn-pin-doc-"));
    const proj = await mkdtemp(join(tmpdir(), "syn-pin-docp-"));
    await write(
      join(home, ".claude", "skills", "writing-packs", "SKILL.md"),
      "---\nname: writing-packs\ndescription: How packs work.\n---\nPins carry a marker like `<!-- mypack-pinned-skill -->` in the body.\n",
    );
    const a = await computeArsenal(proj, home);
    const doc = a.skills.find((s) => s.name === "writing-packs");
    expect(doc).toBeDefined();
    expect(doc?.pack).toBeUndefined();
    expect(doc?.pinned_as).toBeUndefined();
  });
});

describe("computeArsenalDetail", () => {
  async function detailFixture(): Promise<{ home: string; proj: string }> {
    const home = await mkdtemp(join(tmpdir(), "syn-detail-home-"));
    const proj = await mkdtemp(join(tmpdir(), "syn-detail-proj-"));
    await write(
      join(home, ".claude", "skills", "long", "SKILL.md"),
      `---\nname: long-skill\ndescription: |\n  ${"d".repeat(500)}\nmetadata:\n  version: "1.2.3"\n---\n# Long\n\nThe body.\n`,
    );
    await write(
      join(proj, ".claude", "agents", "rel.md"),
      `---\nname: release-manager\ndescription: Ship it.\ntools: ${"T".repeat(400)}\n---\nAgent body.\n`,
    );
    await write(
      join(proj, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          myserver: {
            type: "http",
            url: "https://x.example/mcp?token=abc",
            headers: { Authorization: "Bearer SECRETTOKEN123" },
          },
        },
      }),
    );
    const packDir = join(home, ".claude", "skills", "impeccable");
    await write(join(packDir, "SKILL.md"), "---\nname: impeccable\ndescription: Design.\n---\nB\n");
    await write(
      join(packDir, "scripts", "command-metadata.json"),
      JSON.stringify({ polish: { description: "Final quality pass." } }),
    );
    await write(join(packDir, "reference", "polish.md"), "# Polish\n\nAlignment work.\n");
    return { home, proj };
  }

  it("returns unclipped description, dotted frontmatter, and the body", async () => {
    const { home, proj } = await detailFixture();
    const d = await computeArsenalDetail(
      proj,
      { kind: "skills", scope: "personal", name: "long-skill" },
      home,
    );
    expect(d?.description).toHaveLength(500); // list item was clipped to 300
    expect(d?.frontmatter?.["metadata.version"]).toBe("1.2.3");
    expect(d?.body).toBe("# Long\n\nThe body.\n");
    expect(d?.truncated).toBe(false);
    expect(d?.path).toContain("~/.claude/skills/long/SKILL.md");
  });

  it("serves a pack member's reference file as its body", async () => {
    const { home, proj } = await detailFixture();
    const d = await computeArsenalDetail(
      proj,
      { kind: "skills", scope: "personal", name: "impeccable polish" },
      home,
    );
    expect(d?.pack_command).toBe("polish");
    expect(d?.body).toBe("# Polish\n\nAlignment work.\n");
    expect(d?.frontmatter).toBeUndefined(); // reference files carry none
    expect(d?.description).toBe("Final quality pass.");
  });

  it("returns unclipped agent tools", async () => {
    const { home, proj } = await detailFixture();
    const d = await computeArsenalDetail(
      proj,
      { kind: "agents", scope: "project", name: "release-manager" },
      home,
    );
    expect(d?.frontmatter?.tools).toHaveLength(400);
    expect(d?.meta?.tools).toHaveLength(200); // the list item stays clipped
  });

  it("returns null for an unknown identity", async () => {
    const { home, proj } = await detailFixture();
    const wrongName = { kind: "skills", scope: "personal", name: "nope" } as const;
    const wrongScope = { kind: "skills", scope: "project", name: "long-skill" } as const;
    const wrongSource = {
      kind: "skills",
      scope: "personal",
      name: "long-skill",
      source: "someplugin",
    } as const;
    expect(await computeArsenalDetail(proj, wrongName, home)).toBeNull();
    expect(await computeArsenalDetail(proj, wrongScope, home)).toBeNull();
    expect(await computeArsenalDetail(proj, wrongSource, home)).toBeNull();
  });

  it("never resolves a caller-supplied path", async () => {
    const { home, proj } = await detailFixture();
    for (const name of ["../../../../etc/passwd", "../../.claude.json", "../SKILL.md"]) {
      expect(
        await computeArsenalDetail(proj, { kind: "skills", scope: "personal", name }, home),
      ).toBeNull();
    }
  });

  it("gives MCP items no body and leaks no secret", async () => {
    const { home, proj } = await detailFixture();
    const d = await computeArsenalDetail(
      proj,
      { kind: "mcp", scope: "project", name: "myserver" },
      home,
    );
    expect(d?.body).toBeUndefined();
    expect(d?.path).toBeUndefined();
    expect(d?.meta?.url).toBe("https://x.example/mcp");
    const blob = JSON.stringify(d);
    expect(blob).not.toContain("SECRETTOKEN123");
    expect(blob).not.toContain("Bearer");
    expect(blob).not.toContain("token=abc");
  });

  it("caps an oversized body and reports the true length", async () => {
    const home = await mkdtemp(join(tmpdir(), "syn-detail-big-"));
    const proj = await mkdtemp(join(tmpdir(), "syn-detail-bigp-"));
    const body = "y".repeat(250_000);
    await write(join(home, ".claude", "skills", "big", "SKILL.md"), `---\nname: big\n---\n${body}`);
    const d = await computeArsenalDetail(
      proj,
      { kind: "skills", scope: "personal", name: "big" },
      home,
    );
    expect(d?.body).toHaveLength(200_000);
    expect(d?.body_chars).toBe(250_000);
    expect(d?.truncated).toBe(true);
  });

  // Regression guard: the path index is built by computeArsenal, so a detail
  // request arriving before any /arsenal call must still resolve.
  it("resolves on a cold start with no prior computeArsenal call", async () => {
    const home = await mkdtemp(join(tmpdir(), "syn-detail-cold-"));
    const proj = await mkdtemp(join(tmpdir(), "syn-detail-coldp-"));
    await write(
      join(home, ".claude", "skills", "cold", "SKILL.md"),
      "---\nname: cold\ndescription: First call is the detail one.\n---\nCold body.\n",
    );
    const d = await computeArsenalDetail(
      proj,
      { kind: "skills", scope: "personal", name: "cold" },
      home,
    );
    expect(d?.body).toBe("Cold body.\n");
  });
});
