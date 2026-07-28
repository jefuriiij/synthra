// The Dispatcher: scoring a task prompt against the installed Arsenal must be
// conservative — recommend only on clear signal, silent otherwise — and the
// /route handler must be config-gated and never break a prompt. v0.18 adds the
// difficulty verdict (complex → keep it on the primary model) and the noise
// fixes from the first field report: route stopwords, the min-signal rule,
// the wrong-ecosystem penalty, and name dedupe.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { ArsenalData, ArsenalItem } from "../src/dashboard/arsenal.js";
import type { FileNode, GraphSchema } from "../src/graph/types.js";
import type { ServerContext } from "../src/server/context.js";
import {
  fingerprintKeywords,
  isSystemPrompt,
  normalizePaths,
  renderHint,
  renderRouteReport,
  scoreArsenal,
  scoreDifficulty,
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
const svelteExts = new Map([
  [".svelte", 8],
  [".ts", 2],
]);

// The field report's deliberately hard probe — reconnect + races + teardown +
// leaks are all distinct hard signals.
const HARD_PROMPT = "debug the reconnect races and teardown leaks in the socket listeners";

describe("scoreArsenal", () => {
  it("routes a matching task to the right agent with its own model + reasons", () => {
    const m = scoreArsenal(
      "build a settings page with svelte components",
      arsenal([svelteAgent, genericAgent], [svelteSkill]),
      noExts,
      3,
    );
    expect(m.confident).toBe(true);
    expect(m.difficulty).toBe("standard");
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

  it("fingerprint lifts the project's-language agent and sinks wrong-ecosystem ones", () => {
    expect(fingerprintKeywords(svelteExts).has("svelte")).toBe(true);
    // Prompt mentions neither agent by name; both match two desc words.
    const a = item({ name: "web-dev", description: "svelte implementation expert" });
    const b = item({ name: "site-dev", description: "python implementation expert" });
    const m = scoreArsenal(
      "implementation of the checkout flow expert",
      arsenal([b, a]),
      svelteExts,
      1,
    );
    expect(m.agents[0]?.name).toBe("web-dev"); // +2 fingerprint boost
    expect(m.agents.map((x) => x.name)).not.toContain("site-dev"); // -4 wrong ecosystem
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

  // Pack members are browsable in the Arsenal but never routed: the Dispatcher
  // recommends a skill to load, not a sub-invocation of one.
  it("skips pack members and still routes their parent skill", () => {
    const parent = item({
      name: "impeccable",
      description: "design language for frontend interfaces",
      pack: "impeccable",
    });
    const member = item({
      name: "impeccable polish",
      description: "design pass fixing alignment and spacing before shipping",
      pack: "impeccable",
      pack_command: "polish",
    });
    const m = scoreArsenal(
      "design pass on the dashboard interfaces before shipping",
      arsenal([], [member, parent]),
      noExts,
      1,
    );
    expect(m.skills.map((s) => s.name)).toContain("impeccable");
    expect(m.skills.map((s) => s.name)).not.toContain("impeccable polish");
  });
});

describe("scoreDifficulty (v0.18)", () => {
  it("two or more distinct hard signals score complex", () => {
    expect(
      scoreDifficulty(
        "fix the reconnect races, duplicate delivery and teardown leaks in the socket listeners",
      ),
    ).toBe("complex");
  });

  it("easy prompts and single-signal prompts stay standard", () => {
    expect(scoreDifficulty("change the header color to blue")).toBe("standard");
    expect(scoreDifficulty("run the database migration for the users table")).toBe("standard");
  });
});

describe("difficulty escalation (v0.18)", () => {
  const socketAgent = item({
    name: "socket-debugger",
    description: "Debugs websocket reconnect and teardown issues in event listeners.",
  });

  it("complex task escalates an unpinned agent to opus and switches the hint", () => {
    const m = scoreArsenal(HARD_PROMPT, arsenal([socketAgent]), noExts, 3);
    expect(m.difficulty).toBe("complex");
    expect(m.confident).toBe(true);
    expect(m.agents[0]?.model).toBe("opus");

    const hint = renderHint(m);
    expect(hint).toContain("Complex task");
    expect(hint).toContain("primary model");
    expect(hint).toContain("'socket-debugger' pinned to opus");
    expect(hint).toMatch(/^[\x20-\x7E]+$/); // ASCII-only — survives PS 5.1 stdout
  });

  it("complex verdict still hints when nothing in the arsenal matches", () => {
    // The noise fixes can leave a hard task with zero confident agents — the
    // "stay on your primary model" advice must not go silent with them.
    const m = scoreArsenal(HARD_PROMPT, arsenal([genericAgent]), noExts, 3);
    expect(m.confident).toBe(false);
    const hint = renderHint(m);
    expect(hint).toContain("Complex task");
    expect(hint).not.toContain("delegate to '");
    expect(hint).toMatch(/^[\x20-\x7E]+$/);
  });

  it("an agent's own meta.model pin survives escalation", () => {
    const pinned = item({ ...socketAgent, meta: { model: "haiku" } });
    const m = scoreArsenal(HARD_PROMPT, arsenal([pinned]), noExts, 3);
    expect(m.difficulty).toBe("complex");
    expect(m.agents[0]?.model).toBe("haiku");
  });

  it("standard tasks keep the sonnet default and the delegate hint", () => {
    const m = scoreArsenal(
      "build a settings page with svelte components",
      arsenal([svelteAgent]),
      noExts,
      3,
    );
    expect(m.difficulty).toBe("standard");
    const hint = renderHint(m);
    expect(hint).toContain("delegate execution");
    expect(hint).not.toContain("Complex task");
    expect(hint).toMatch(/^[\x20-\x7E]+$/);
  });
});

describe("scoring noise fixes (v0.18)", () => {
  it("wrong-ecosystem agents are filtered on a fingerprinted repo (field replay)", () => {
    // The field report: powershell-module-architect won a Svelte concurrency
    // task via its "module" name token. The -4 penalty must zero it out.
    const psArchitect = item({
      name: "powershell-module-architect",
      description: "Architecting and refactoring PowerShell modules and profile systems.",
    });
    const m = scoreArsenal(
      "fix the reconnect races and teardown leaks across the socket module listeners",
      arsenal([psArchitect]),
      svelteExts,
      1,
    );
    expect(m.agents).toEqual([]);
    expect(m.confident).toBe(false);
  });

  it("a single generic description hit no longer ranks (min-signal rule)", () => {
    const deployAgent = item({
      name: "deploy-helper",
      description: "handles deployment rollout of releases",
    });
    const m = scoreArsenal(
      "review the rollout schedule for the marketing site",
      arsenal([deployAgent]),
      noExts,
      1,
    );
    expect(m.agents).toEqual([]);
  });

  it("a name-token hit alone still ranks", () => {
    const rolloutAgent = item({
      name: "rollout-manager",
      description: "coordinates staged releases",
    });
    const m = scoreArsenal(
      "review the rollout schedule for the marketing site",
      arsenal([rolloutAgent]),
      noExts,
      3,
    );
    expect(m.agents[0]?.name).toBe("rollout-manager");
    expect(m.confident).toBe(true);
  });

  it("glue words (add/new/app/across/without) carry no signal on either side", () => {
    const glue = item({ name: "glue", description: "add new app across without make change" });
    const m = scoreArsenal(
      "add a new app across the workspace without tests",
      arsenal([glue]),
      noExts,
      1,
    );
    expect(m.confident).toBe(false);
    expect(m.agents).toEqual([]);
  });

  it("dedupes same-named items (personal copy + plugin copy), keeping the strongest", () => {
    const personalCopy = item({
      name: "svelte-best-practices",
      description: "Svelte component patterns and sidebar styling conventions.",
    });
    const pluginCopy = item({
      name: "Svelte-Best-Practices",
      scope: "plugin",
      description: "Svelte component patterns.",
    });
    const m = scoreArsenal(
      "restyle the svelte component patterns for the sidebar",
      arsenal([], [personalCopy, pluginCopy]),
      noExts,
      3,
    );
    expect(m.skills.length).toBe(1);
    expect(m.skills[0]?.name).toBe("svelte-best-practices");
  });
});

describe("input hygiene (v0.21) — the field failures", () => {
  // Every fixture below is a real prompt shape from route_log.jsonl, where the
  // first field window put 112 of 166 hints on harness noise and let directory
  // names pick the agent.
  it("isSystemPrompt catches IDE notices, task notifications, and reminders", () => {
    expect(
      isSystemPrompt("<ide_opened_file>The user opened the file c:\\x</ide_opened_file>"),
    ).toBe(true);
    expect(
      isSystemPrompt("<ide_selection>The user selected the lines 81 to 81</ide_selection>"),
    ).toBe(true);
    expect(isSystemPrompt("<task-notification>\n<task-id>bhigip0gc</task-id>")).toBe(true);
    expect(isSystemPrompt("<system-reminder>do the thing</system-reminder>")).toBe(true);
    expect(isSystemPrompt("<local-command-stdout>ok</local-command-stdout>")).toBe(true);
  });

  it("isSystemPrompt leaves real prompts alone, including pasted markup", () => {
    expect(isSystemPrompt("build a settings page with svelte components")).toBe(false);
    expect(isSystemPrompt("  fix the reconnect races  ")).toBe(false);
    expect(isSystemPrompt("<div class='hero'> needs a dark variant")).toBe(false);
  });

  it("normalizePaths keeps the basename and drops the directories", () => {
    expect(normalizePaths("i tried in /data/horses block")).toBe("i tried in horses block");
    expect(normalizePaths("fix src/lib/socket.ts please")).toBe("fix socket please");
    expect(normalizePaths("update Documents\\Windsor Project")).toBe("update Windsor Project");
    // A 10-segment IDE path collapses to its two basenames (the space in
    // "custom modules" makes it two words) instead of ~10 voting tokens.
    expect(normalizePaths("c:\\Users\\Jeff\\hs-wwd\\custom modules\\X.module\\module.html")).toBe(
      "custom module",
    );
    expect(normalizePaths("no paths here at all")).toBe("no paths here at all");
  });

  it("a URL path no longer routes to data-analyst (the /data/horses miss)", () => {
    const dataAnalyst = item({
      name: "data-analyst",
      description: "Extract insights from business data, dashboards and reports.",
    });
    const m = scoreArsenal(
      'i tried in /data/horses block and the toast says "Could not save"',
      arsenal([dataAnalyst]),
      noExts,
      3,
    );
    expect(m.agents).toEqual([]);
  });

  it("a role word alone never wins (the test-automator / project-manager misses)", () => {
    const testAutomator = item({
      name: "test-automator",
      description: "Build automated test frameworks and CI pipelines.",
    });
    const projectManager = item({
      name: "project-manager",
      description: "Establish plans, track progress, manage risks and stakeholders.",
    });
    const easy = scoreArsenal(
      "before i deploy it, i want to test them locally",
      arsenal([testAutomator]),
      noExts,
      3,
    );
    expect(easy.agents).toEqual([]);

    const pathy = scoreArsenal(
      "before you update the Documents\\Windsor Project - Phases doc",
      arsenal([projectManager]),
      noExts,
      3,
    );
    expect(pathy.agents).toEqual([]);
  });

  it("a strong domain name hit still ranks (the fix must not silence everything)", () => {
    const m = scoreArsenal(
      "build a settings page with svelte components",
      arsenal([svelteAgent], [svelteSkill]),
      noExts,
      5,
    );
    expect(m.confident).toBe(true);
    expect(m.agents[0]?.name).toBe("svelte-ui-builder");
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

    expect(renderHint({ confident: false, difficulty: "standard", agents: [], skills: [] })).toBe(
      "",
    );
  });

  it("report lists agents with scores, the difficulty, and a verdict-matched policy", () => {
    const m = scoreArsenal(
      "build a settings page with svelte components",
      arsenal([svelteAgent, genericAgent], [svelteSkill]),
      noExts,
      3,
    );
    const report = renderRouteReport("build a settings page", m);
    expect(report).toContain("Difficulty: standard");
    expect(report).toContain("Recommended agents:");
    expect(report).toContain("`svelte-ui-builder` (model: sonnet)");
    expect(report).toContain("standard task");
    expect(report).toContain("sonnet");

    const empty = renderRouteReport("zzz", {
      confident: false,
      difficulty: "standard",
      agents: [],
      skills: [],
    });
    expect(empty).toContain("No strong match");
  });

  it("complex report carries the escalation policy instead of the sonnet default", () => {
    const socketAgent = item({
      name: "socket-debugger",
      description: "Debugs websocket reconnect and teardown issues in event listeners.",
    });
    const report = renderRouteReport(
      HARD_PROMPT,
      scoreArsenal(HARD_PROMPT, arsenal([socketAgent]), noExts, 3),
    );
    expect(report).toContain("Difficulty: complex");
    expect(report).toContain("scored COMPLEX");
    expect(report).toContain("primary model");

    const noMatch = renderRouteReport("x", {
      confident: false,
      difficulty: "complex",
      agents: [],
      skills: [],
    });
    expect(noMatch).toContain("No strong match");
    expect(noMatch).toContain("scored COMPLEX");
  });
});

describe("handleRoute", () => {
  afterEach(() => {
    delete process.env.SYN_NO_ROUTE;
    delete process.env.SYN_ROUTE_HINTS;
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

  it("returns a hint for a confident match when injection is enabled", async () => {
    process.env.SYN_ROUTE_HINTS = "1";
    const ctx = await ctxWithGraph();
    const res = await handleRoute(
      { prompt: "build a settings page with svelte components" },
      ctx,
      deps,
    );
    expect(res.hint).toContain("ui-builder");
  });

  it("shadow mode (the v0.21 default) injects nothing but still logs the verdict", async () => {
    const ctx = await ctxWithGraph();
    const res = await handleRoute(
      { prompt: "build a settings page with svelte components" },
      ctx,
      deps,
    );
    expect(res.hint).toBe("");

    const entry = JSON.parse((await readFile(ctx.paths.routeLog, "utf8")).trim());
    expect(entry.matched).toBe(true); // the scorer WAS confident
    expect(entry.routed).toBe(false); // …it just wasn't allowed to speak
    expect(entry.agent).toBe("svelte-ui-builder");
  });

  it("skips harness-injected pseudo-prompts entirely — no hint, no log line", async () => {
    process.env.SYN_ROUTE_HINTS = "1";
    const ctx = await ctxWithGraph();
    for (const prompt of [
      "<ide_opened_file>The user opened the file c:\\proj\\src\\lib\\svelte\\settings.svelte</ide_opened_file>",
      "<ide_selection>The user selected lines 1 to 9 from c:\\proj\\components\\page.svelte</ide_selection>",
      "<task-notification>\n<task-id>abc</task-id>\nsvelte settings components page\n</task-notification>",
      "<system-reminder>svelte settings page components</system-reminder>",
    ]) {
      expect((await handleRoute({ prompt }, ctx, deps)).hint).toBe("");
    }
    // Nothing logged at all — these aren't prompts the human typed.
    await expect(readFile(ctx.paths.routeLog, "utf8")).rejects.toThrow();
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

  it("logs the top recommendation (agent + model) alongside the difficulty (v0.19)", async () => {
    process.env.SYN_ROUTE_HINTS = "1";
    const ctx = await ctxWithGraph();
    await handleRoute({ prompt: "build a settings page with svelte components" }, ctx, deps);
    await handleRoute({ prompt: "investigate the database migration failure" }, ctx, deps);

    const lines = (await readFile(ctx.paths.routeLog, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);

    const confident = JSON.parse(lines[0] as string);
    expect(confident.agent).toBe("svelte-ui-builder");
    expect(confident.model).toBe("sonnet");
    expect(confident.difficulty).toBe("standard");
    expect(confident.routed).toBe(true);

    const silent = JSON.parse(lines[1] as string);
    expect(silent.agent).toBeUndefined();
    expect(silent.routed).toBe(false);
  });
});
