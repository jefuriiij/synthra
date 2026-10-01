// The large Synthra panel (extension/src/panelTabs.ts + html.ts): the view the
// webview renders, the keys its clicks send back, and the page's CSP. Pure, so
// tested here like the sidebar trees.

import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { buildCsp, buildHtml } from "../extension/src/html.js";
import { buildTabs, messageTabs } from "../extension/src/panelTabs.js";
import type { PanelsPayload } from "../extension/src/panelTrees.js";

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
