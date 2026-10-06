// The dashboard's report card (GET /overview), its health check and the
// "Fix hooks" route. The pure parts are tested on hand-made logs; the rest
// against a temp project and a temp home, so the developer's real registry
// never leaks in.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRepair } from "../src/dashboard/repair.js";
import { pickProject } from "../src/dashboard/pick-project.js";
import { recordProject } from "../src/shared/project-registry.js";
import type { ProjectFiles } from "../src/dashboard/delta.js";
import {
  compareVersions,
  computeCost,
  computeFinding,
  computeOverview,
  diagnose,
} from "../src/dashboard/overview.js";
import { hooksState, installHooks } from "../src/hooks/installer.js";
import { fileHash } from "../src/scanner/hash.js";
import { flushHeartbeat, noteHook } from "../src/server/heartbeat.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function files(over: Partial<ProjectFiles> = {}): ProjectFiles {
  return {
    path: "/p",
    name: "p",
    last_seen: null,
    tokens: [],
    gates: [],
    tools: [],
    bash: [],
    routes: [],
    delegations: [],
    ...over,
  };
}

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.34.0", "0.9.1")).toBe(1);
    expect(compareVersions("0.33.0", "0.34.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
  });
});

describe("diagnose", () => {
  it("names missing and old hooks first, with the fix", () => {
    expect(diagnose({ hooks: {}, hooks_state: "missing" }, undefined, NOW)).toMatchObject({
      fix: "hooks",
      problem: expect.stringContaining("missing"),
    });
    expect(diagnose({ hooks: {}, hooks_state: "outdated" }, undefined, NOW)).toMatchObject({
      fix: "hooks",
      problem: expect.stringContaining("older Synthra"),
    });
  });

  // The 0.33 subfolder bug, as the page saw it: sessions start, replies stop.
  it("spots replies that stopped while sessions kept starting", () => {
    const h = { hooks: { start: ago(0), reply: ago(18) }, hooks_state: "current" as const };
    expect(diagnose(h, undefined, NOW).problem).toMatch(/no reply was logged since/);
    // The registry's last_seen counts as a start for servers without a heartbeat.
    expect(diagnose({ hooks: {}, hooks_state: "current" }, ago(1), NOW).problem).toMatch(
      /no reply was ever logged/,
    );
  });

  // After Fix hooks the logs still look stalled: only the next reply can tell.
  it("waits for the next reply after a fix, instead of asking for it again", () => {
    const h = { hooks: { start: ago(1), reply: ago(30) }, hooks_state: "current" as const };
    expect(diagnose(h, undefined, NOW, ago(0.5))).toEqual({
      note: expect.stringContaining("next reply here will confirm"),
    });
    // Hooks written by the start itself (seconds later) are no fix.
    const bySelf = new Date(Date.parse(ago(1)) + 3000).toISOString();
    expect(diagnose(h, undefined, NOW, bySelf).problem).toMatch(/no reply was logged since/);
  });

  it("says nothing about a healthy project, or one nobody used lately", () => {
    const fresh = { hooks: { start: ago(0), reply: ago(0) }, hooks_state: "current" as const };
    expect(diagnose(fresh, undefined, NOW)).toEqual({});
    const idle = { hooks: { reply: ago(60) }, hooks_state: "current" as const };
    expect(diagnose(idle, ago(40), NOW)).toEqual({});
    expect(diagnose({ hooks: {}, hooks_state: "newer" }, undefined, NOW)).toEqual({});
  });
});

describe("computeFinding", () => {
  const p = files({
    tools: [
      { ts: ago(1), tool: "graph_read" },
      { ts: ago(1), tool: "graph_continue" },
      { ts: ago(1), tool: "memory" }, // not a lookup
      { ts: ago(20), tool: "find_symbol" }, // outside a 7-day window
    ],
    gates: [
      { ts: ago(2), tool: "Grep", decision: "block", query: "login" },
      { ts: ago(2), tool: "Glob", decision: "allow", query: "*.css" },
    ],
    tokens: [
      {
        ts: ago(1),
        input_tokens: 1,
        output_tokens: 1,
        model: "claude-opus-5",
        project: "/p",
        read_calls: 3,
      },
    ],
    bash: [
      {
        ts: ago(1),
        kind: "search",
        tool: "grep",
        query: "handleLogin",
        confidence: "high",
        avoidable: true,
      },
      {
        ts: ago(1),
        kind: "read",
        tool: "cat",
        query: "src/a.ts",
        confidence: null,
        avoidable: false,
      },
      { ts: ago(3), kind: "list", tool: "ls", query: null, confidence: null, avoidable: false },
    ],
  });

  it("sorts lookups into map, whole files and search", () => {
    const f = computeFinding([p], NOW - 7 * DAY, NOW);
    // map: 2 lookup tools + 1 stopped search; files: 3 Reads + cat; search: Glob + grep + ls
    expect([f.map, f.files, f.search]).toEqual([3, 4, 3]);
    expect([f.terminal, f.missed]).toEqual([3, 1]);
    expect(f.missed_examples).toEqual([{ tool: "grep", text: "handleLogin" }]);
    expect(f.reads_counted).toBe(true);
  });

  it("keeps four weekly buckets whatever the window, oldest first", () => {
    const f = computeFinding([p], NOW - 7 * DAY, NOW);
    expect(f.weeks).toHaveLength(4);
    expect(f.weeks[3]).toMatchObject({ map: 3, files: 4, search: 3 });
    expect(f.weeks[1]).toMatchObject({ map: 1 }); // the find_symbol 20 days ago
  });

  it("knows when no Stop hook counted reads yet", () => {
    expect(computeFinding([files()], NOW - 7 * DAY, NOW).reads_counted).toBe(false);
  });
});

describe("computeCost", () => {
  it("sums this window and the one before, by model, with the priciest replies", () => {
    const t = (days: number, model: string, out: number) => ({
      ts: ago(days),
      input_tokens: 0,
      output_tokens: out,
      model,
      project: "/p",
    });
    const c = computeCost(
      [
        files({
          tokens: [
            t(1, "claude-opus-5", 100_000),
            t(2, "claude-sonnet-5", 100_000),
            t(9, "claude-opus-5", 100_000),
          ],
        }),
      ],
      NOW - 7 * DAY,
      NOW,
    );
    expect(c.replies).toBe(2);
    expect(c.spend).toBeGreaterThan(0);
    expect(c.previous).toBeGreaterThan(0);
    expect(Object.keys(c.models).sort()).toEqual(["opus", "sonnet"]);
    expect(c.priciest[0]?.model).toBe("claude-opus-5");
  });
});

// A temp home: the registry, USER.md and skill state all live under it.
const HOME_VARS = ["HOME", "USERPROFILE"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  saved = Object.fromEntries(HOME_VARS.map((k) => [k, process.env[k]]));
  const home = await mkdtemp(join(tmpdir(), "syn-overview-home-"));
  for (const k of HOME_VARS) process.env[k] = home;
});
afterEach(() => {
  for (const k of HOME_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function project(): Promise<SynthraPaths> {
  const root = await mkdtemp(join(tmpdir(), "syn-overview-"));
  await mkdir(join(root, ".synthra-graph"), { recursive: true });
  return resolvePaths(root);
}

describe("computeOverview", () => {
  it("reports a healthy project, its memory and an out-of-date note", async () => {
    const paths = await project();
    await installHooks(paths);
    noteHook(paths.heartbeat, "start", "0.34.0");
    noteHook(paths.heartbeat, "reply", "0.34.0");
    await flushHeartbeat(paths.heartbeat);

    await mkdir(paths.contextDir, { recursive: true });
    await writeFile(paths.memoryMd, "- Build with npm run build\n- Tests: npm test\n", "utf8");
    await writeFile(join(paths.projectRoot, "a.ts"), "export const a = 2;\n", "utf8");
    await writeFile(
      paths.contextStore,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            type: "decision",
            content: "a is two",
            tags: [],
            files: ["a.ts"],
            date: ago(1),
            anchors: [{ path: "a.ts", hash: fileHash("export const a = 1;\n") }],
          },
        ],
      }),
      "utf8",
    );

    const o = await computeOverview(paths, { days: 7, version: "0.34.0", now: Date.now() });
    const h = o.health.find((x) => x.path === paths.projectRoot);
    expect(h).toMatchObject({ hooks_state: "current", version: "0.34.0" });
    expect(h?.problem).toBeUndefined();
    expect(o.memory?.project).toMatchObject({ exists: true, entries: 2 });
    expect(o.memory?.notes).toBe(1);
    expect(o.memory?.stale_notes).toBe(1);
    expect(o.learning).toMatchObject({ live: 0, waiting: 0 });
  });

  it("shows another known project from any window, with every project's numbers", async () => {
    const own = await project();
    const other = await project();
    await recordProject(own.projectRoot);
    await recordProject(other.projectRoot);
    const reply = (out: number, hoursAgo: number) =>
      `${JSON.stringify({ ts: new Date(Date.now() - hoursAgo * 3600e3).toISOString(), input_tokens: 0, output_tokens: out, model: "claude-opus-5" })}\n`;
    await writeFile(own.tokenLog, reply(100_000, 1), "utf8");
    await writeFile(other.tokenLog, reply(300_000, 1) + reply(300_000, 2), "utf8");
    await mkdir(other.contextDir, { recursive: true });
    await writeFile(other.memoryMd, "- Other project fact\n", "utf8");

    // The other project, asked for from this window's dashboard.
    const target = await pickProject(own, other.projectRoot);
    expect(target?.projectRoot).toBe(other.projectRoot);
    const o = await computeOverview(target as SynthraPaths, {
      days: 7,
      version: "0.39.0",
      home: own.projectRoot,
    });
    expect(o.project.path).toBe(other.projectRoot);
    expect(o.home?.path).toBe(own.projectRoot);
    expect(o.memory?.project).toMatchObject({ exists: true, entries: 1 });
    expect(o.this_project?.cost.replies).toBe(2);
    expect(o.cost.replies).toBe(3);
    const n = (p: SynthraPaths) => o.projects?.find((x) => x.path === p.projectRoot);
    expect(n(own)).toMatchObject({ replies: 1 });
    expect(n(other)).toMatchObject({ replies: 2 });
    expect(n(other)?.spend ?? 0).toBeGreaterThan(n(own)?.spend ?? 0);
  });

  it("never opens a folder that isn't in the project list", async () => {
    const own = await project();
    const stranger = await project();
    expect(await pickProject(own, undefined)).toBe(own);
    expect(await pickProject(own, own.projectRoot)).toBe(own);
    expect(await pickProject(own, stranger.projectRoot)).toBeNull();
    expect(await pickProject(own, "C:\\Windows")).toBeNull();
  });

  it("hides a folder Synthra no longer runs in", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-overview-gone-"));
    const o = await computeOverview(resolvePaths(root), { days: 7, version: "0.34.0" });
    expect(o.health).toEqual([]);
  });
});

describe("POST /repair (Fix hooks)", () => {
  const PORT = 8901;
  const json = (body: unknown, extra: Partial<{ contentType: string; origin: string }> = {}) => ({
    contentType: "application/json",
    origin: undefined,
    body,
    ...extra,
  });

  it("rewrites the hooks of the dashboard's own project", async () => {
    const paths = await project();
    expect(await hooksState(paths)).toBe("missing");
    const r = await handleRepair(json({ path: paths.projectRoot }), paths, PORT);
    expect(r.status).toBe(200);
    expect(await hooksState(paths)).toBe("current");
  });

  it("refuses a folder that is not a Synthra project here, and a cross-site post", async () => {
    const paths = await project();
    const other = await mkdtemp(join(tmpdir(), "syn-overview-other-"));
    expect((await handleRepair(json({ path: other }), paths, PORT)).status).toBe(404);
    expect((await handleRepair(json({}), paths, PORT)).status).toBe(404);
    expect(
      (
        await handleRepair(
          json({ path: paths.projectRoot }, { contentType: "text/plain" }),
          paths,
          PORT,
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handleRepair(
          json({ path: paths.projectRoot }, { origin: "https://evil.example" }),
          paths,
          PORT,
        )
      ).status,
    ).toBe(403);
    expect(await hooksState(paths)).toBe("missing");
  });
});
