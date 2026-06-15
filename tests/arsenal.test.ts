// Arsenal scanner — reads Claude Code's on-disk skills/agents/MCP across
// project, personal (~/.claude), and plugin scopes. computeArsenal takes an
// injectable homeDir so we can point it at a temp fake-home.

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { computeArsenal, parseFrontmatter } from "../src/dashboard/arsenal.js";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
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

  it("does not throw on a malformed skill and skips nothing else", async () => {
    const { home, proj } = await fixture();
    const a = await computeArsenal(proj, home);
    // broken skill still yields an item (fallback name from dir), but never crashes
    expect(a.skills.some((s) => s.name === "demo-skill")).toBe(true);
  });
});
