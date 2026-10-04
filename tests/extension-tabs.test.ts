// The large Synthra panel (extension/src/panelTabs.ts + html.ts): the view the
// webview renders, the keys its clicks send back, and the page's CSP. Pure, so
// tested here like the sidebar trees.

import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { buildCsp, buildHtml } from "../extension/src/html.js";
import {
  buildTabs,
  mergePrompt,
  messageTabs,
  REPO_RE,
  tildify,
  UPDATE_COMMAND_RE,
} from "../extension/src/panelTabs.js";
import { type PanelsPayload, proposalTitle } from "../extension/src/panelTrees.js";

const ROOT = "/work/aster";

function payload(over: Partial<PanelsPayload> = {}): PanelsPayload {
  return {
    version: 1,
    project_root: ROOT,
    memory: {
      branch: "main",
      store_path: `${ROOT}/.synthra/context-store.json`,
      context_md_path: `${ROOT}/.synthra/CONTEXT.md`,
      entries: [],
    },
    capabilities: { skills: [], agents: [], mcp: [], scanned_at: "2026-10-02T00:00:00.000Z" },
    agents: { since: "2026-09-25T00:00:00.000Z", delegations: [] },
    ...over,
  };
}

describe("Memory tab", () => {
  const p = payload({
    memory: {
      ...payload().memory,
      entries: [
        {
          kind: "task",
          content: "Milestone 2",
          tags: [],
          files: [],
          date: "2026-08-16T00:00:00.000Z",
          stale: [],
        },
        {
          kind: "decision",
          content: "Use Hono",
          tags: ["server"],
          files: ["src/http.ts"],
          date: "2026-08-20T00:00:00.000Z",
          stale: ["src/http.ts"],
        },
        {
          kind: "task",
          content: "Milestone 3",
          tags: [],
          files: [],
          date: "2026-08-23T00:00:00.000Z",
          stale: [],
        },
      ],
    },
  });

  it("puts only the newest task first, and older ones in a folded section", () => {
    const { view } = buildTabs(ROOT, p);
    const m = view.memory!;
    expect(m.total).toBe(3);
    expect(m.stale).toBe(1);
    expect(m.sections.map((s) => [s.kind, s.folded, s.notes.map((n) => n.text)])).toEqual([
      ["task", false, ["Milestone 3"]],
      ["decision", false, ["Use Hono"]],
      ["earlier", true, ["Milestone 2"]],
    ]);
    expect(m.sections[1]?.notes[0]).toMatchObject({
      tags: ["server"],
      stale: ["src/http.ts"],
      at: Date.parse("2026-08-20T00:00:00.000Z"),
    });
  });

  // The page can only send back a key it was given; the key resolves on the
  // host side to the path the server named.
  it("hands out keys for files and CONTEXT.md, and maps them to real paths", () => {
    const { view, targets } = buildTabs(ROOT, p);
    const file = view.memory!.sections[1]!.notes[0]!.files[0]!;
    expect(file.path).toBe("src/http.ts");
    expect(targets.get(file.key!)).toEqual({ kind: "file", path: join(ROOT, "src/http.ts") });
    expect(targets.get(view.memory!.contextMd!)).toEqual({
      kind: "file",
      path: `${ROOT}/.synthra/CONTEXT.md`,
    });
    expect(targets.get("not-a-key")).toBeUndefined();
  });

  it("says the store is unreadable and offers only the store file", () => {
    const { view, targets } = buildTabs(
      ROOT,
      payload({ memory: { ...payload().memory, unreadable: "Unexpected token" } }),
    );
    expect(view.memory).toMatchObject({ unreadable: "Unexpected token", sections: [] });
    expect([...targets.values()]).toEqual([
      { kind: "file", path: `${ROOT}/.synthra/context-store.json` },
    ]);
  });
});

describe("Memory tab — knowledge cards", () => {
  it("gives MEMORY.md and USER.md a card each, with a key only for a file that exists", () => {
    const { view, targets } = buildTabs(
      ROOT,
      payload({
        memory: {
          ...payload().memory,
          files: {
            project: {
              path: `${ROOT}/.synthra/MEMORY.md`,
              exists: true,
              entries: ["Use pnpm"],
              chars: 8,
              limit: 3500,
            },
            user: {
              path: "/home/me/.synthra/USER.md",
              exists: false,
              entries: [],
              chars: 0,
              limit: 2000,
            },
          },
        },
      }),
    );
    const [project, user] = view.memory!.files;
    expect(project).toMatchObject({
      target: "project",
      shownPath: ".synthra/MEMORY.md",
      entries: ["Use pnpm"],
    });
    expect(targets.get(project!.key!)).toEqual({
      kind: "file",
      path: `${ROOT}/.synthra/MEMORY.md`,
    });
    expect(user).toMatchObject({ target: "user", exists: false });
    expect(user?.key).toBeUndefined();
  });

  it("has no cards from a server older than 0.33", () => {
    expect(buildTabs(ROOT, payload()).view.memory?.files).toEqual([]);
  });
});

describe("Capabilities tab", () => {
  it("groups by source, keeps plugin names, and opens only items with a file", () => {
    const { view, targets } = buildTabs(
      ROOT,
      payload({
        capabilities: {
          ...payload().capabilities,
          skills: [
            { name: "deploy", description: "Ship", scope: "project", file: `${ROOT}/s/SKILL.md` },
            { name: "mine", description: "", scope: "personal" },
            {
              name: "docs",
              description: "Docs",
              scope: "plugin",
              source: "anthropic-skills",
              file: "/home/me/docs/SKILL.md",
            },
            { name: "pack", description: "", scope: "plugin", source: "design", commands: 12 },
          ],
          agents: [
            { name: "reviewer", description: "", scope: "personal", meta: { model: "sonnet" } },
          ],
          mcp: [
            {
              name: "notion",
              description: "",
              scope: "plugin",
              source: "design",
              enabled: false,
              meta: { type: "http" },
            },
          ],
        },
      }),
    );
    const c = view.capabilities!;
    expect(c.skills.map((r) => [r.name, r.group, r.extra ?? null])).toEqual([
      ["deploy", "This project", null],
      ["mine", "Yours", null],
      ["docs", "anthropic-skills", null],
      ["pack", "design", "12 commands"],
    ]);
    expect(targets.get(c.skills[0]!.key!)?.path).toBe(`${ROOT}/s/SKILL.md`);
    expect(c.skills[1]?.key).toBeUndefined();
    expect(c.agents[0]?.extra).toBe("sonnet");
    expect(c.mcp[0]).toMatchObject({ extra: "http", off: true });
    expect(c.plugins).toEqual([
      { name: "anthropic-skills", skills: 1, agents: 0, mcp: 0, off: false },
      { name: "design", skills: 1, agents: 0, mcp: 1, off: true },
    ]);
  });

  // The row menu: what may be done to each skill comes from the engine.
  it("offers favorite, edit, delete and merge only where the engine allows them", () => {
    const { view, targets } = buildTabs(
      ROOT,
      payload({
        capabilities: {
          ...payload().capabilities,
          skills: [
            {
              name: "rail-light",
              description: "",
              scope: "personal",
              file: "/home/me/.claude/skills/rail-light/SKILL.md",
              synthra: true,
              pinned: true,
              stale_days: 16,
              uses: 3,
              last_used: "2026-10-01T00:00:00.000Z",
              files: ["references/timing.md"],
              files_more: 2,
              editable: true,
              deletable: true,
            },
            {
              name: "ask-sonner",
              description: "",
              scope: "personal",
              file: "/home/me/.claude/skills/ask-sonner/SKILL.md",
              third_party: "emilkowalski/skills",
              linked_to: "/home/me/.agents/skills/ask-sonner",
              editable: true,
            },
            {
              name: "docs",
              description: "",
              scope: "plugin",
              source: "x",
              file: "/p/docs/SKILL.md",
            },
            // An engine older than 0.36 sends no facts: no actions then.
            {
              name: "old",
              description: "",
              scope: "project",
              file: `${ROOT}/.claude/skills/old/SKILL.md`,
            },
          ],
        },
      }),
    );
    const [rail, sonner, docs, old] = view.capabilities!.skills;
    expect(rail).toMatchObject({
      synthra: true,
      favorite: true,
      staleDays: 16,
      uses: 3,
      lastUsed: Date.parse("2026-10-01T00:00:00.000Z"),
      filesMore: 2,
      canFavorite: true,
      canDelete: true,
      canMerge: true,
    });
    expect(targets.get(rail!.edit!)).toEqual({
      kind: "file",
      path: "/home/me/.claude/skills/rail-light/SKILL.md",
      preview: false,
    });
    expect(targets.get(rail!.files![0]!.key)?.path).toBe(
      join("/home/me/.claude/skills/rail-light", "references", "timing.md"),
    );
    expect(sonner).toMatchObject({ thirdParty: "emilkowalski/skills", canFavorite: true });
    expect(sonner?.canDelete).toBeUndefined();
    expect(sonner?.canMerge).toBeUndefined();
    expect(docs).toMatchObject({ canFavorite: true });
    expect(docs?.edit).toBeUndefined();
    expect(old?.canFavorite).toBeUndefined();
    expect(old?.canDelete).toBeUndefined();
  });

  it("writes a merge request that names every skill and how to archive them", () => {
    const text = mergePrompt([
      { name: "rail-light", path: "/a/SKILL.md" },
      { name: "tilt-badge", path: "/b/SKILL.md" },
    ]);
    expect(text).toContain("- rail-light (/a/SKILL.md)");
    expect(text).toContain("- tilt-badge (/b/SKILL.md)");
    expect(text).toContain("absorbed_into");
    expect(text).toContain("references/<topic>.md");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it("lists installed skills under their repo, with their update state", () => {
    const skill = (name: string, over: Record<string, unknown> = {}) => ({
      name,
      description: name,
      scope: "personal" as const,
      file: `/home/me/.claude/skills/${name}/SKILL.md`,
      editable: true as const,
      ...over,
    });
    const { view } = buildTabs(
      ROOT,
      payload({
        capabilities: {
          ...payload().capabilities,
          skills: [
            skill("mine", { deletable: true }),
            skill("taste", {
              third_party: "Leonxlnx/taste-skill",
              updatable: "taste",
              update: "available",
            }),
            skill("kept", { third_party: "Leonxlnx/taste-skill", updatable: "kept", held: true }),
            skill("gone", { third_party: "a/b", updatable: "gone", update: "moved" }),
          ],
          updates: { checked_at: "2026-10-04T10:00:00.000Z", errors: ["c/d: not found"] },
        },
      }),
    );
    const c = view.capabilities;
    const row = (n: string) => c?.skills.find((r) => r.name === n);
    expect(row("mine")?.group).toBe("Yours");
    expect(row("taste")).toMatchObject({
      group: "Leonxlnx/taste-skill",
      updatable: "taste",
      update: "available",
    });
    expect(row("kept")).toMatchObject({ group: "Leonxlnx/taste-skill", held: true });
    expect(row("gone")).toMatchObject({ group: "a/b", update: "moved" });
    expect(row("mine")?.updatable).toBeUndefined();
    expect(c?.updates).toEqual({
      checkedAt: Date.parse("2026-10-04T10:00:00.000Z"),
      errors: ["c/d: not found"],
    });
  });

  it("runs only the update command the engine writes, and opens only repo slugs", () => {
    expect(UPDATE_COMMAND_RE.test("npx -y skills update taste react:components -g -y")).toBe(true);
    expect(UPDATE_COMMAND_RE.test("npx -y skills update taste -g -y; rm -rf ~")).toBe(false);
    expect(UPDATE_COMMAND_RE.test("npx -y skills update -g -y")).toBe(false);
    expect(UPDATE_COMMAND_RE.test("npx -y skills update a&&b -g -y")).toBe(false);
    expect(REPO_RE.test("Leonxlnx/taste-skill")).toBe(true);
    expect(REPO_RE.test("evil.com/x/y")).toBe(false);
    expect(REPO_RE.test("javascript:alert(1)")).toBe(false);
  });

  it("passes a scan error through", () => {
    const { view } = buildTabs(
      ROOT,
      payload({ capabilities: { ...payload().capabilities, error: "EACCES" } }),
    );
    expect(view.capabilities?.error).toBe("EACCES");
  });
});

describe("Agents tab", () => {
  it("names each helper by its task and counts them per agent", () => {
    const { view } = buildTabs(
      ROOT,
      payload({
        agents: {
          since: "2026-09-25T00:00:00.000Z",
          delegations: [
            {
              ts: "2026-10-02T11:00:00.000Z",
              agent: "Explore",
              model: null,
              description: "Map it",
            },
            { ts: "2026-10-02T10:00:00.000Z", agent: null, model: "sonnet", description: null },
            { ts: "garbage", agent: "Explore", model: null, description: null },
            { ts: "2026-10-01T10:00:00.000Z", agent: "Explore", model: null, description: null },
          ],
        },
      }),
    );
    expect(view.agents?.recent.map((a) => [a.title, a.agent, a.model ?? null])).toEqual([
      ["Map it", "Explore", null],
      ["general-purpose", "general-purpose", "sonnet"],
      ["Explore", "Explore", null],
    ]);
    expect(view.agents?.most).toEqual([
      { agent: "Explore", count: 2 },
      { agent: "general-purpose", count: 1 },
    ]);
  });
});

describe("Settings tab", () => {
  it("groups the server's settings, keeping each one's value and source", () => {
    const row = (key: string, group: string, extra: Record<string, unknown> = {}) => ({
      key,
      group,
      label: key,
      help: "",
      type: "number" as const,
      value: 1,
      default: 1,
      source: "default" as const,
      env: `SYN_${key}`,
      ...extra,
    });
    const { view } = buildTabs(
      ROOT,
      payload({
        settings: {
          path: "/home/me/.synthra/settings.json",
          settings: [
            row("memoryNudgeEvery", "Memory", { value: 4, source: "file" }),
            row("memoryChars", "Memory"),
            row("routeHints", "Dispatcher", { type: "boolean", value: true, source: "env" }),
          ],
        },
      }),
    );
    expect(view.settings?.path).toBe("/home/me/.synthra/settings.json");
    expect(
      view.settings?.groups.map((g) => [g.name, g.rows.map((r) => [r.key, r.value, r.source])]),
    ).toEqual([
      [
        "Memory",
        [
          ["memoryNudgeEvery", 4, "file"],
          ["memoryChars", 1, "default"],
        ],
      ],
      ["Dispatcher", [["routeHints", true, "env"]]],
    ]);
  });

  it("is absent with a server older than 0.33", () => {
    expect(buildTabs(ROOT, payload()).view.settings).toBeUndefined();
  });

  it("shows the home folder as ~", () => {
    expect(tildify("/home/me/.synthra/settings.json", "/home/me")).toBe("~/.synthra/settings.json");
    expect(tildify("C:\\Users\\me\\.synthra\\s.json", "C:\\Users\\me")).toBe("~\\.synthra\\s.json");
    expect(tildify("/home/meg/x", "/home/me")).toBe("/home/meg/x");
  });
});

describe("message view", () => {
  it("carries the folder name and the line, and opens nothing", () => {
    const { view, targets } = messageTabs("/work/aster", "Synthra is starting…");
    expect(view).toEqual({ project: "aster", message: "Synthra is starting…" });
    expect(targets.size).toBe(0);
  });
});

describe("panel HTML", () => {
  it("allows only the nonce'd script and never the network", () => {
    const csp = buildCsp("vscode-webview://abc", "N0nce==");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-N0nce=='");
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toMatch(/https:/);
  });

  it("escapes what it puts in attributes", () => {
    const html = buildHtml({
      cspSource: "vscode-webview://abc",
      nonce: 'a"b',
      scriptUri: "https://file+.vscode-resource/x.js?a=1&b=2",
      styleUri: "s.css",
    });
    expect(html).toContain('nonce="a&quot;b"');
    expect(html).toContain("x.js?a=1&amp;b=2");
    expect(html).not.toContain('nonce="a"b"');
  });
});

describe("what a waiting change is called", () => {
  const base = {
    id: "x-000000",
    ts: "2026-10-02T00:00:00.000Z",
    scope: "global" as const,
    name: "css-motion",
    path: "/s/SKILL.md",
    description: "",
    before: null,
    after: "",
    stale: false,
  };
  it("names support files, the user's own skills, and merges", () => {
    expect(proposalTitle({ ...base, action: "create" })).toBe("New skill");
    expect(proposalTitle({ ...base, action: "create", file: "references/a.md" })).toBe(
      "New file references/a.md in",
    );
    expect(proposalTitle({ ...base, action: "patch", file: "references/a.md" })).toBe(
      "Changed references/a.md in",
    );
    expect(proposalTitle({ ...base, action: "remove", file: "references/a.md" })).toBe(
      "Remove references/a.md in",
    );
    expect(proposalTitle({ ...base, action: "patch", owner: "user" })).toBe("Change to your skill");
    expect(proposalTitle({ ...base, action: "archive", absorbedInto: "css-motion" })).toBe(
      "Merge into css-motion:",
    );
    expect(proposalTitle({ ...base, action: "archive" })).toBe("Archive");
  });
});
