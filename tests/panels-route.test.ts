// v0.33 — `GET /panels`: the data behind the IDE extension's sidebar (Memory,
// Capabilities, Agents). One read for all three, each section failing on its
// own.

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { GraphSchema } from "../src/graph/types.js";
import type { ServerContext } from "../src/server/context.js";
import { startServer } from "../src/server/http.js";
import { PANELS_VERSION, handlePanels } from "../src/server/routes/panels.js";
import { resolvePaths } from "../src/shared/paths.js";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function graphWith(files: Record<string, string>): GraphSchema {
  const nodes = Object.entries(files).map(([path, hash]) => ({
    id: `file:${path}`,
    kind: "file" as const,
    path,
    ext: ".ts",
    size: 1,
    keywords: [],
    content: "",
    file_hash: hash,
  }));
  return {
    root: "/",
    node_count: nodes.length,
    edge_count: 0,
    file_count: nodes.length,
    symbol_count: 0,
    nodes,
    edges: [],
    generated_at: "2026-10-02T00:00:00.000Z",
    schema_version: 1,
  };
}

/** A project on branch `main` (the default), and an empty fake home. */
async function fixture(files: Record<string, string> = {}) {
  const project = await mkdtemp(join(tmpdir(), "syn-panels-proj-"));
  const home = await mkdtemp(join(tmpdir(), "syn-panels-home-"));
  await write(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const paths = resolvePaths(project);
  const ctx: ServerContext = {
    paths,
    graph: graphWith(files),
    symbolIndex: {},
    activity: new ActivityStore(paths.activityLog),
  };
  return { project, home, paths, ctx };
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

describe("GET /panels — memory", () => {
  it("lists this branch's entries and flags the ones whose files changed", async () => {
    const { home, paths, ctx } = await fixture({ "src/auth.ts": "h-new", "src/db.ts": "h-db" });
    await write(
      join(paths.contextDir, "context-store.json"),
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            type: "decision",
            content: "Tokens expire after 15 minutes",
            tags: ["auth"],
            files: ["src/auth.ts"],
            date: "2026-09-30T10:00:00.000Z",
            anchors: [{ path: "src/auth.ts", hash: "h-old" }],
          },
          {
            type: "fact",
            content: "The pool size is 10",
            tags: [],
            files: ["src/db.ts"],
            date: "2026-09-30T11:00:00.000Z",
            anchors: [{ path: "src/db.ts", hash: "h-db" }],
          },
        ],
      }),
    );

    const p = await handlePanels(ctx, { homeDir: home });

    expect(p.version).toBe(PANELS_VERSION);
    expect(p.memory.branch).toBe("main");
    expect(p.memory.store_path).toBe(join(paths.contextDir, "context-store.json"));
    expect(p.memory.unreadable).toBeUndefined();
    expect(p.memory.entries.map((e) => [e.kind, e.stale])).toEqual([
      ["decision", ["src/auth.ts"]],
      ["fact", []],
    ]);
  });

  // "You have no memory" and "your memory file is damaged" need different
  // reactions — and the other panels must still work.
  it("says the store is unreadable instead of showing it as empty", async () => {
    const { project, home, paths, ctx } = await fixture();
    await write(join(paths.contextDir, "context-store.json"), "{ not json");
    await write(
      join(project, ".claude", "skills", "deploy", "SKILL.md"),
      skillMd("deploy", "Ship"),
    );

    const p = await handlePanels(ctx, { homeDir: home });

    expect(p.memory.entries).toEqual([]);
    expect(p.memory.unreadable).toBeTruthy();
    expect(p.capabilities.skills.map((s) => s.name)).toEqual(["deploy"]);
  });
});

describe("GET /panels — capabilities", () => {
  it("gives each skill and agent the file it came from; MCP servers get none", async () => {
    const { project, home, ctx } = await fixture();
    const skill = join(project, ".claude", "skills", "deploy", "SKILL.md");
    const agent = join(home, ".claude", "agents", "reviewer.md");
    await write(skill, skillMd("deploy", "Ship the app"));
    await write(
      agent,
      "---\nname: reviewer\ndescription: Reviews code\nmodel: sonnet\n---\nBody\n",
    );
    await write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: { synthra: { type: "http", url: "http://127.0.0.1:8080/mcp" } },
      }),
    );

    const p = await handlePanels(ctx, { homeDir: home, fresh: true });

    expect(p.capabilities.error).toBeUndefined();
    expect(p.capabilities.skills).toEqual([
      expect.objectContaining({ name: "deploy", scope: "project", file: skill }),
    ]);
    expect(p.capabilities.agents).toEqual([
      expect.objectContaining({ name: "reviewer", scope: "personal", file: agent }),
    ]);
    expect(p.capabilities.mcp).toEqual([
      expect.objectContaining({ name: "synthra", scope: "project" }),
    ]);
    expect(p.capabilities.mcp[0]?.file).toBeUndefined();
  });

  // The extension asks for `fresh` when a SKILL.md changed: without it, a skill
  // written a moment ago stays missing until the 15s memo runs out.
  it("rescans on `fresh` and serves the memo otherwise", async () => {
    const { project, home, ctx } = await fixture();
    await write(join(project, ".claude", "skills", "one", "SKILL.md"), skillMd("one", "First"));
    const first = await handlePanels(ctx, { homeDir: home, fresh: true });
    expect(first.capabilities.skills.map((s) => s.name)).toEqual(["one"]);

    await write(join(project, ".claude", "skills", "two", "SKILL.md"), skillMd("two", "Second"));
    const memo = await handlePanels(ctx, { homeDir: home });
    expect(memo.capabilities.skills.map((s) => s.name)).toEqual(["one"]);

    const fresh = await handlePanels(ctx, { homeDir: home, fresh: true });
    expect(fresh.capabilities.skills.map((s) => s.name)).toEqual(["one", "two"]);
  });
});

describe("GET /panels — agents", () => {
  it("lists the last week's helpers, newest first, with their task names", async () => {
    const { home, paths, ctx } = await fixture();
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    const lines = [
      { ts: "2026-09-20T12:00:00.000Z", agent: "old-one", model: null, session_id: "s0" },
      { ts: "2026-10-01T09:00:00.000Z", agent: "Explore", model: null, session_id: "s1" },
      {
        ts: "2026-10-02T11:00:00.000Z",
        agent: "general-purpose",
        model: "sonnet",
        description: "Research Hermes Agent",
        session_id: "s2",
      },
    ];
    await write(
      paths.delegationLog,
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`,
    );

    const p = await handlePanels(ctx, { homeDir: home, now });

    expect(p.agents.since).toBe("2026-09-25T12:00:00.000Z");
    expect(p.agents.delegations).toEqual([
      {
        ts: "2026-10-02T11:00:00.000Z",
        agent: "general-purpose",
        model: "sonnet",
        description: "Research Hermes Agent",
        session_id: "s2",
      },
      {
        ts: "2026-10-01T09:00:00.000Z",
        agent: "Explore",
        model: null,
        description: null,
        session_id: "s1",
      },
    ]);
  });

  it("is empty, not an error, before Claude has started any helper", async () => {
    const { home, ctx } = await fixture();
    const p = await handlePanels(ctx, { homeDir: home });
    expect(p.agents.delegations).toEqual([]);
  });
});

// What the Capabilities tab offers on a skill row: who owns it, its use, and
// the files beside its SKILL.md.
describe("GET /panels: what Synthra knows about each skill", () => {
  it("marks Synthra's skills, the user's own, and installed ones, with use and files", async () => {
    const { project, home, ctx } = await fixture();
    const paths = {
      ...ctx.paths,
      globalSkillsDir: join(home, ".claude", "skills"),
      skillState: join(home, ".synthra", "skills"),
    };
    const c = { ...ctx, paths };
    const mine = join(project, ".claude", "skills", "release", "SKILL.md");
    const yours = join(project, ".claude", "skills", "deploy", "SKILL.md");
    const installed = join(home, ".claude", "skills", "ask-sonner", "SKILL.md");
    await write(
      mine,
      "---\nname: release\ndescription: Use when releasing.\nmetadata:\n  synthra: learned\n---\nSteps\n",
    );
    await write(join(project, ".claude", "skills", "release", "references", "tags.md"), "t");
    await write(join(project, ".claude", "skills", "release", ".hidden"), "h");
    await write(yours, skillMd("deploy", "Ship the app"));
    await write(installed, skillMd("ask-sonner", "Toasts"));
    await write(
      join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({ skills: { "ask-sonner": { source: "emilkowalski/skills" } } }),
    );
    await write(
      join(paths.skillState, "usage.json"),
      JSON.stringify({ [mine]: { uses: 12, lastUsed: "2026-10-01T10:00:00.000Z" } }),
    );
    await write(join(paths.skillState, "pins.json"), JSON.stringify({ pinned: [mine] }));

    const p = await handlePanels(c, { homeDir: home, fresh: true });
    const row = (name: string) => p.capabilities.skills.find((s) => s.name === name);

    expect(row("release")).toMatchObject({
      synthra: true,
      pinned: true,
      uses: 12,
      last_used: "2026-10-01T10:00:00.000Z",
      files: ["references/tags.md"],
      editable: true,
      deletable: true,
    });
    expect(row("deploy")).toMatchObject({ editable: true, deletable: true });
    expect(row("deploy")?.synthra).toBeUndefined();
    expect(row("deploy")?.files).toBeUndefined();
    expect(row("ask-sonner")).toMatchObject({
      third_party: "emilkowalski/skills",
      editable: true,
    });
    expect(row("ask-sonner")?.deletable).toBeUndefined();
  });
});

describe("GET /panels — over HTTP", () => {
  it("answers on the running server", async () => {
    const { project } = await fixture();
    const handle = await startServer(resolvePaths(project), { version: "test" });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/panels?fresh=1`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: number; project_root: string };
      expect(body.version).toBe(PANELS_VERSION);
      expect(body.project_root).toBe(project);
    } finally {
      await handle.stop();
    }
  });
});
