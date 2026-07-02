// The Dispatcher: scoring a task prompt against the installed Arsenal must be
// conservative — recommend only on clear signal, silent otherwise — and the
// /route handler must be config-gated and never break a prompt.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { ArsenalData, ArsenalItem } from "../src/dashboard/arsenal.js";
import type { FileNode, GraphSchema } from "../src/graph/types.js";
import type { ServerContext } from "../src/server/context.js";
import {
  fingerprintKeywords,
  renderHint,
  renderRouteReport,
  scoreArsenal,
} from "../src/server/routes/route-match.js";
import { handleRoute } from "../src/server/routes/route.js";
import { resolvePaths } from "../src/shared/paths.js";

function item(over: Partial<ArsenalItem> & { name: string }): ArsenalItem {
  return { description: "", scope: "personal", ...over };
}

function arsenal(agents: ArsenalItem[], skills: ArsenalItem[] = []): ArsenalData {
  return {
    skills,
    agents,
    mcp: [],
    counts: { skills: skills.length, agents: agents.length, mcp: 0, plugins: 0 },
    scanned_at: "2026-07-02T00:00:00.000Z",
  };
}

const svelteAgent = item({
  name: "svelte-ui-builder",
  description: "Svelte UI implementation specialist. Builds components, settings pages, styling.",
  meta: { model: "sonnet" },
});
const genericAgent = item({
  name: "helper",
  description: "General purpose assistant for research and multi-step tasks.",
});
const svelteSkill = item({
  name: "svelte-code-writer",
  description: "CLI tools for Svelte 5 documentation lookup and code analysis.",
});

const noExts = new Map<string, number>();

describe("scoreArsenal", () => {
  it("routes a matching task to the right agent with its own model + reasons", () => {
    const m = scoreArsenal(
      "build a settings page with svelte components",
      arsenal([svelteAgent, genericAgent], [svelteSkill]),
      noExts,
      3,
    );
    expect(m.confident).toBe(true);
    expect(m.agents[0]?.name).toBe("svelte-ui-builder");
    expect(m.agents[0]?.model).toBe("sonnet");
    expect(m.agents[0]?.reason).toContain("svelte");
    expect(m.skills[0]?.name).toBe("svelte-code-writer");
  });

  it("defaults the model to sonnet when the agent doesn't pin one", () => {
    const agent = item({ name: "page-builder", description: "builds settings pages quickly" });
    const m = scoreArsenal("build the settings page now", arsenal([agent]), noExts, 3);
    expect(m.agents[0]?.model).toBe("sonnet");
  });

  it("is not confident below the min score or on trivial prompts", () => {
    const weak = scoreArsenal(
      "investigate the database migration failure",
      arsenal([svelteAgent]),
      noExts,
      3,
    );
    expect(weak.confident).toBe(false);

    const trivial = scoreArsenal("hi there", arsenal([svelteAgent]), noExts, 3);
    expect(trivial.confident).toBe(false);
    expect(trivial.agents).toEqual([]);
  });

  it("fingerprint boost lifts the project's-language agent over a generic tie", () => {
    const svelteExts = new Map([
      [".svelte", 8],
      [".ts", 2],
    ]);
    expect(fingerprintKeywords(svelteExts).has("svelte")).toBe(true);
    // Prompt mentions neither agent by name; both match "implementation" weakly.
    const a = item({ name: "web-dev", description: "svelte implementation expert" });
    const b = item({ name: "app-dev", description: "python implementation expert" });
    const m = scoreArsenal(
      "implementation of the new feature flow",
      arsenal([b, a]),
      svelteExts,
      1,
    );
    expect(m.agents[0]?.name).toBe("web-dev"); // +2 fingerprint boost wins
  });

  it("skips disabled items and caps skills at 2", () => {
    const off = item({ name: "svelte-off", description: "svelte svelte svelte", enabled: false });
    const s1 = item({ name: "s1", description: "svelte styling" });
    const s2 = item({ name: "s2", description: "svelte components" });
    const s3 = item({ name: "s3", description: "svelte pages" });
    const m = scoreArsenal(
      "build svelte components and styling for pages",
      arsenal([svelteAgent, off], [s1, s2, s3]),
      noExts,
      3,
    );
    expect(m.agents.map((a) => a.name)).not.toContain("svelte-off");
    expect(m.skills.length).toBe(2);
  });
});

describe("renderHint / renderRouteReport", () => {
  it("hint names agent + model + top skill, stays compact; '' when unconfident", () => {
    const m = scoreArsenal(
      "build a settings page with svelte components",
      arsenal([svelteAgent], [svelteSkill]),
      noExts,
      3,
    );
    const hint = renderHint(m);
    expect(hint).toContain("ui-builder");
    expect(hint).toContain("model: sonnet");
    expect(hint).toContain("svelte-code-writer");
    expect(hint.length).toBeLessThanOrEqual(300);

    expect(renderHint({ confident: false, agents: [], skills: [] })).toBe("");
  });

  it("report lists agents with scores and falls back gracefully on no match", () => {
    const m = scoreArsenal(
      "build a settings page with svelte components",
      arsenal([svelteAgent, genericAgent], [svelteSkill]),
      noExts,
      3,
    );
    const report = renderRouteReport("build a settings page", m);
    expect(report).toContain("Recommended agents:");
    expect(report).toContain("`svelte-ui-builder` (model: sonnet)");
    expect(report).toContain("Model policy");

    const empty = renderRouteReport("zzz", { confident: false, agents: [], skills: [] });
    expect(empty).toContain("No strong match");
  });
});

describe("handleRoute", () => {
  afterEach(() => {
    delete process.env.SYN_NO_ROUTE;
  });

  async function ctxWithGraph(): Promise<ServerContext> {
    const dir = await mkdtemp(join(tmpdir(), "syn-route-"));
    const paths = resolvePaths(dir);
    const f: FileNode = {
      id: "file:src/App.svelte",
      kind: "file",
      path: "src/App.svelte",
      ext: ".svelte",
      size: 1,
      keywords: [],
      content: "",
      summary: "",
      file_hash: "x",
    };
    const graph: GraphSchema = {
      root: dir,
      node_count: 1,
      edge_count: 0,
      file_count: 1,
      symbol_count: 0,
      nodes: [f],
      edges: [],
      generated_at: "2026-07-02T00:00:00.000Z",
      schema_version: 2,
    };
    return { paths, graph, symbolIndex: {}, activity: new ActivityStore(paths.activityLog) };
  }
  const deps = { arsenal: async () => arsenal([svelteAgent], [svelteSkill]) };

  it("returns a hint for a confident match and logs it", async () => {
    const ctx = await ctxWithGraph();
    const res = await handleRoute(
      { prompt: "build a settings page with svelte components" },
      ctx,
      deps,
    );
    expect(res.hint).toContain("ui-builder");
  });

  it("stays silent on weak prompts, empty prompts, and when disabled", async () => {
    const ctx = await ctxWithGraph();
    expect((await handleRoute({ prompt: "hi" }, ctx, deps)).hint).toBe("");
    expect((await handleRoute({}, ctx, deps)).hint).toBe("");

    process.env.SYN_NO_ROUTE = "1";
    expect(
      (await handleRoute({ prompt: "build a settings page with svelte components" }, ctx, deps))
        .hint,
    ).toBe("");
  });

  it("never throws when the arsenal scan fails", async () => {
    const ctx = await ctxWithGraph();
    const res = await handleRoute({ prompt: "build a settings page with svelte components" }, ctx, {
      arsenal: async () => {
        throw new Error("boom");
      },
    });
    expect(res.hint).toBe("");
  });
});
