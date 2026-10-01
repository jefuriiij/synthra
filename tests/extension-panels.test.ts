// The IDE extension's sidebar trees (extension/src/panelTrees.ts): Memory,
// Capabilities, Agents. Pure, so they are tested here like logic.ts. The last
// block feeds a real GET /panels answer through them — the payload types are
// copied into the extension, and that is where a drift would show.

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  agentsView,
  capabilitiesView,
  memoryView,
  PANELS_VERSION as EXT_PANELS_VERSION,
  type PanelItem,
  type PanelMemoryEntry,
  type PanelNode,
  type PanelsPayload,
  relativeTime,
} from "../extension/src/panelTrees.js";
import { ActivityStore } from "../src/activity/activity-log.js";
import { PANELS_VERSION, handlePanels } from "../src/server/routes/panels.js";
import { resolvePaths } from "../src/shared/paths.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function payload(over: Partial<PanelsPayload> = {}): PanelsPayload {
  return {
    version: 1,
    project_root: "/proj",
    memory: {
      branch: "main",
      store_path: "/proj/.synthra/context-store.json",
      context_md_path: "/proj/.synthra/CONTEXT.md",
      entries: [],
    },
    capabilities: { skills: [], agents: [], mcp: [], scanned_at: "2026-10-02T12:00:00.000Z" },
    agents: { since: "2026-09-25T12:00:00.000Z", delegations: [] },
    ...over,
  };
}

const entry = (over: Partial<PanelMemoryEntry>): PanelMemoryEntry => ({
  kind: "fact",
  content: "something",
  tags: [],
  files: [],
  date: "2026-10-01T12:00:00.000Z",
  stale: [],
  ...over,
});

const labels = (nodes: PanelNode[] | undefined) => (nodes ?? []).map((n) => n.label);
const find = (nodes: PanelNode[], id: string) => nodes.find((n) => n.id === id);

describe("relativeTime", () => {
  it("reads like a person would say it", () => {
    expect(relativeTime("2026-10-02T11:59:40.000Z", NOW)).toBe("just now");
    expect(relativeTime("2026-10-02T11:55:00.000Z", NOW)).toBe("5 min ago");
    expect(relativeTime("2026-10-02T09:00:00.000Z", NOW)).toBe("3 h ago");
    expect(relativeTime("2026-10-01T10:00:00.000Z", NOW)).toBe("yesterday");
    expect(relativeTime("2026-09-28T12:00:00.000Z", NOW)).toBe("4 days ago");
    expect(relativeTime("2026-06-01T12:00:00.000Z", NOW)).toBe("2026-06-01");
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});

describe("Memory panel", () => {
  it("groups by kind, most urgent first, newest entry first in each group", () => {
    const v = memoryView(
      payload({
        memory: {
          ...payload().memory,
          entries: [
            entry({ kind: "decision", content: "Use Hono", date: "2026-09-01T00:00:00.000Z" }),
            entry({ kind: "task", content: "Build the sidebar" }),
            entry({ kind: "decision", content: "Keep tooltips plain text" }),
            entry({ kind: "next", content: "Write the skill tool" }),
          ],
        },
      }),
      NOW,
    );
    expect(labels(v.nodes)).toEqual(["Current task", "Next steps", "Decisions", "CONTEXT.md"]);
    expect(labels(find(v.nodes, "mem:kind:decision")?.children)).toEqual([
      "Keep tooltips plain text",
      "Use Hono",
    ]);
    // The store index is the id: it survives a refresh.
    expect(find(v.nodes, "mem:kind:decision")?.children?.map((n) => n.id)).toEqual([
      "mem:2",
      "mem:0",
    ]);
    expect(v.description).toBe("main");
    expect(v.message).toBeUndefined();
  });

  it("marks entries whose files changed, and opens the file a note is about", () => {
    const v = memoryView(
      payload({
        memory: {
          ...payload().memory,
          entries: [
            entry({
              content: "Tokens expire after 15 minutes\nmore detail",
              files: ["src/auth.ts"],
              stale: ["src/auth.ts"],
            }),
            entry({ content: "No file here" }),
          ],
        },
      }),
      NOW,
    );
    const facts = find(v.nodes, "mem:kind:fact");
    expect(facts?.description).toBe("2 · 1 may be out of date");
    const [noFile, stale] = facts?.children ?? [];
    expect(stale?.label).toBe("Tokens expire after 15 minutes");
    expect(stale?.icon?.id).toBe("warning");
    expect(stale?.description).toBe("may be out of date · yesterday");
    expect(stale?.open).toEqual({ kind: "file", path: join("/proj", "src/auth.ts") });
    expect(stale?.tooltip).toContain("Changed since this was saved: src/auth.ts");
    expect(noFile?.open).toBeUndefined();
  });

  it("says when nothing is remembered yet", () => {
    const v = memoryView(payload(), NOW);
    expect(v.nodes).toEqual([]);
    expect(v.message).toContain("branch main");
  });

  // An unreadable store must not look like an empty one.
  it("says when the memory file can't be read, and offers to open it", () => {
    const v = memoryView(
      payload({ memory: { ...payload().memory, unreadable: "Unexpected token" } }),
      NOW,
    );
    expect(v.message).toContain("can't read");
    expect(v.message).toContain("Unexpected token");
    expect(v.nodes[0]?.open).toEqual({ kind: "file", path: "/proj/.synthra/context-store.json" });
  });
});

describe("Capabilities panel", () => {
  const item = (over: Partial<PanelItem>): PanelItem => ({
    name: "x",
    description: "",
    scope: "project",
    ...over,
  });

  it("groups by where an item comes from, and plugins by plugin", () => {
    const v = capabilitiesView(
      payload({
        capabilities: {
          ...payload().capabilities,
          skills: [
            item({ name: "deploy", file: "/proj/.claude/skills/deploy/SKILL.md" }),
            item({ name: "mine", scope: "personal" }),
            item({ name: "impeccable", scope: "plugin", source: "design", commands: 12 }),
            item({ name: "brief", scope: "plugin", source: "marketing", enabled: false }),
          ],
          agents: [item({ name: "reviewer", scope: "personal", meta: { model: "sonnet" } })],
          mcp: [item({ name: "synthra", meta: { type: "http" } })],
        },
      }),
    );
    expect(labels(v.nodes)).toEqual(["Skills", "Agents", "Connected tools (MCP)", "Plugins"]);
    const skills = find(v.nodes, "cap:skills");
    expect(labels(skills?.children)).toEqual([
      "This project",
      "Yours (all projects)",
      "From plugins",
    ]);
    const fromPlugins = find(skills?.children ?? [], "cap:skills:plugin");
    expect(labels(fromPlugins?.children)).toEqual(["design", "marketing"]);
    const impeccable = fromPlugins?.children?.[0]?.children?.[0];
    expect(impeccable?.description).toBe("12 commands");
    const brief = fromPlugins?.children?.[1]?.children?.[0];
    expect(brief?.description).toBe("off");

    const deploy = find(skills?.children ?? [], "cap:skills:project")?.children?.[0];
    expect(deploy?.open).toEqual({ kind: "file", path: "/proj/.claude/skills/deploy/SKILL.md" });

    const agent = find(v.nodes, "cap:agents")?.children?.[0]?.children?.[0];
    expect(agent?.description).toBe("sonnet");

    const plugins = find(v.nodes, "cap:plugins");
    expect(plugins?.children?.map((n) => [n.label, n.description])).toEqual([
      ["design", "1 skill"],
      ["marketing", "1 skill · off"],
    ]);
  });

  it("says when the scan failed instead of showing nothing", () => {
    const v = capabilitiesView(
      payload({ capabilities: { ...payload().capabilities, error: "EACCES" } }),
    );
    expect(v.nodes).toEqual([]);
    expect(v.message).toContain("EACCES");
  });
});

describe("Agents panel", () => {
  it("lists recent helpers by task name and counts them per agent", () => {
    const v = agentsView(
      payload({
        agents: {
          since: "2026-09-25T12:00:00.000Z",
          delegations: [
            {
              ts: "2026-10-02T11:00:00.000Z",
              agent: "Explore",
              model: null,
              description: "Map Synthra's features",
            },
            { ts: "2026-10-02T10:00:00.000Z", agent: null, model: "sonnet", description: null },
            { ts: "2026-10-01T10:00:00.000Z", agent: "Explore", model: null, description: null },
          ],
        },
      }),
      NOW,
    );
    const recent = find(v.nodes, "agents:recent");
    expect(recent?.children?.map((n) => [n.label, n.description])).toEqual([
      ["Map Synthra's features", "Explore · 1 h ago"],
      ["general-purpose", "sonnet · 2 h ago"],
      ["Explore", "yesterday"],
    ]);
    const most = find(v.nodes, "agents:most");
    expect(most?.children?.map((n) => [n.label, n.description])).toEqual([
      ["Explore", "2 times"],
      ["general-purpose", "1 time"],
    ]);
  });

  it("says when Claude used no helper this week", () => {
    const v = agentsView(payload(), NOW);
    expect(v.nodes).toEqual([]);
    expect(v.message).toContain("last 7 days");
  });
});

describe("extension ↔ server contract", () => {
  it("speaks the same payload version as the server", () => {
    expect(EXT_PANELS_VERSION).toBe(PANELS_VERSION);
  });

  it("renders a real GET /panels answer", async () => {
    const project = await mkdtemp(join(tmpdir(), "syn-extpanels-proj-"));
    const home = await mkdtemp(join(tmpdir(), "syn-extpanels-home-"));
    const write = async (path: string, text: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    };
    await write(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    const paths = resolvePaths(project);
    await write(
      join(paths.contextDir, "context-store.json"),
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            type: "task",
            content: "Build the sidebar",
            tags: [],
            files: ["extension/src/panels.ts"],
            date: "2026-10-02T10:00:00.000Z",
          },
        ],
      }),
    );
    await write(
      join(project, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship it\n---\nBody\n",
    );
    await write(
      paths.delegationLog,
      `${JSON.stringify({ ts: "2026-10-02T11:00:00.000Z", agent: "Explore", model: null, description: "Look around" })}\n`,
    );

    const p = (await handlePanels(
      {
        paths,
        graph: {
          root: project,
          node_count: 0,
          edge_count: 0,
          file_count: 0,
          symbol_count: 0,
          nodes: [],
          edges: [],
          generated_at: "2026-10-02T00:00:00.000Z",
          schema_version: 1,
        },
        symbolIndex: {},
        activity: new ActivityStore(paths.activityLog),
      },
      { homeDir: home, fresh: true, now: NOW },
    )) as PanelsPayload;

    const memory = memoryView(p, NOW);
    expect(labels(memory.nodes)).toEqual(["Current task", "CONTEXT.md"]);
    expect(memory.nodes[0]?.children?.[0]?.open).toEqual({
      kind: "file",
      path: join(project, "extension/src/panels.ts"),
    });

    const caps = capabilitiesView(p);
    const deploy = find(caps.nodes, "cap:skills")?.children?.[0]?.children?.[0];
    expect(deploy?.label).toBe("deploy");
    expect(deploy?.open?.path).toBe(join(project, ".claude", "skills", "deploy", "SKILL.md"));

    const agents = agentsView(p, NOW);
    expect(agents.nodes[0]?.children?.[0]?.label).toBe("Look around");
  });
});
