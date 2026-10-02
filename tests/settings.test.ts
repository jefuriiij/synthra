// ~/.synthra/settings.json — the user-facing settings the IDE's Settings tab
// edits. Environment variable, then file, then default; values are checked
// and clamped; unknown keys a newer Synthra wrote are kept.

import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import { patchAgentsMd } from "../src/hooks/agents-md.js";
import type { ServerContext } from "../src/server/context.js";
import { startServer } from "../src/server/http.js";
import { handleSettingsPost, settingsView } from "../src/server/routes/settings.js";
import { loadConfig } from "../src/shared/config.js";
import { resolvePaths } from "../src/shared/paths.js";
import { resolveSettings, settingValues, writeSetting } from "../src/shared/settings.js";

// Every override a developer might have exported, or the defaults below fail.
const ENV = [
  "SYN_SETTINGS",
  "SYN_MEMORY_NUDGE_EVERY",
  "SYN_MEMORY_CHARS",
  "SYN_USER_CHARS",
  "SYN_SKILL_APPROVAL",
  "SYN_SKILL_NUDGE_EVERY",
  "SYN_CURATOR",
  "SYN_ROUTE_HINTS",
];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A fresh settings file for this test; no SYN_* overrides. */
async function freshFile(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "syn-settings-")), "settings.json");
  process.env.SYN_SETTINGS = path;
  for (const k of ENV.slice(1)) delete process.env[k];
  return path;
}

const source = (key: string) => resolveSettings().find((r) => r.def.key === key)?.source;

describe("settings file", () => {
  it("uses the defaults when there is no file", async () => {
    await freshFile();
    expect(settingValues()).toEqual({
      memoryNudgeEvery: 10,
      memoryChars: 3500,
      userChars: 2000,
      skillApproval: true,
      skillNudgeEvery: 15,
      curator: true,
      routeHints: false,
    });
    expect(source("memoryChars")).toBe("default");
  });

  it("reads what is saved, and loadConfig sees it at once", async () => {
    await freshFile();
    expect(writeSetting("memoryNudgeEvery", 4)).toEqual({ ok: true });
    expect(writeSetting("routeHints", true)).toEqual({ ok: true });
    expect(loadConfig()).toMatchObject({ memoryNudgeEvery: 4, routeHints: true });
    expect(source("memoryNudgeEvery")).toBe("file");
  });

  it("lets an environment variable win over the file", async () => {
    await freshFile();
    writeSetting("memoryChars", 5000);
    process.env.SYN_MEMORY_CHARS = "4200";
    expect(loadConfig().memoryChars).toBe(4200);
    expect(source("memoryChars")).toBe("env");
  });

  it("clamps numbers to their range and refuses what isn't a value", async () => {
    await freshFile();
    writeSetting("memoryChars", 10);
    expect(loadConfig().memoryChars).toBe(500);
    expect(writeSetting("memoryChars", "lots")).toMatchObject({ ok: false });
    expect(writeSetting("routeHints", "maybe")).toMatchObject({ ok: false });
    expect(writeSetting("noSuchSetting", 1)).toMatchObject({ ok: false });
  });

  it("goes back to the default on null, and keeps keys it doesn't know", async () => {
    const path = await freshFile();
    await writeFile(path, JSON.stringify({ memoryNudgeEvery: 3, futureThing: "x" }), "utf8");
    writeSetting("memoryNudgeEvery", null);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ futureThing: "x" });
    expect(loadConfig().memoryNudgeEvery).toBe(10);
  });

  it("reads a broken file as empty", async () => {
    const path = await freshFile();
    await writeFile(path, "{ not json", "utf8");
    expect(settingValues().memoryChars).toBe(3500);
  });
});

describe("settings routes", () => {
  async function ctx(): Promise<ServerContext> {
    const dir = await mkdtemp(join(tmpdir(), "syn-settings-proj-"));
    const paths = resolvePaths(dir);
    return {
      paths,
      graph: {
        root: dir,
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
    };
  }

  it("describes every setting with its value and where it came from", async () => {
    const path = await freshFile();
    process.env.SYN_ROUTE_HINTS = "1";
    const v = settingsView();
    expect(v.path).toBe(path);
    expect(v.settings.map((s) => [s.key, s.value, s.source])).toEqual([
      ["memoryNudgeEvery", 10, "default"],
      ["memoryChars", 3500, "default"],
      ["userChars", 2000, "default"],
      ["skillApproval", true, "default"],
      ["skillNudgeEvery", 15, "default"],
      ["curator", true, "default"],
      ["routeHints", true, "env"],
    ]);
    expect(v.settings[0]).toMatchObject({ type: "number", min: 0, max: 100, unit: "replies" });
  });

  // AGENTS.md states the limits in words for other AI tools.
  it("rewrites AGENTS.md when a limit changes", async () => {
    await freshFile();
    const c = await ctx();
    await patchAgentsMd(c.paths.agentsMd);
    const r = await handleSettingsPost({ key: "memoryChars", value: 4800 }, c);
    expect(r.ok).toBe(true);
    expect(await readFile(c.paths.agentsMd, "utf8")).toContain("MEMORY.md 4,800 characters");
  });

  it("answers an error with the current settings", async () => {
    await freshFile();
    const r = await handleSettingsPost({ key: "memoryChars", value: "lots" }, await ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("number from 500 to 20000");
    expect(r.settings).toHaveLength(7);
  });

  it("is served over HTTP, and /panels carries it too", async () => {
    await freshFile();
    const dir = await mkdtemp(join(tmpdir(), "syn-settings-http-"));
    const handle = await startServer(resolvePaths(dir), { version: "test" });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const post = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "memoryNudgeEvery", value: 0 }),
      });
      expect(((await post.json()) as { ok: boolean }).ok).toBe(true);
      const get = (await (await fetch(`${base}/settings`)).json()) as {
        settings: { key: string; value: unknown }[];
      };
      expect(get.settings.find((s) => s.key === "memoryNudgeEvery")?.value).toBe(0);
      const panels = (await (await fetch(`${base}/panels`)).json()) as {
        settings?: { settings: unknown[] };
      };
      expect(panels.settings?.settings).toHaveLength(7);
    } finally {
      await handle.stop();
    }
  });
});
