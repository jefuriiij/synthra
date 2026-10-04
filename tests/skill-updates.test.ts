// v0.38 — updates for the skills installed with `npx skills`: one GitHub tree
// per source, the lock's folder hash against GitHub's, a "don't update" list,
// and what an update would change. GitHub is a fake here: no network.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { ActivityStore } from "../src/activity/activity-log.js";
import {
  type Fetch,
  checkUpdates,
  readLockEntries,
  setHold,
  updateCommand,
  updateDiff,
  updateFacts,
} from "../src/learn/skill-updates.js";
import type { ServerContext } from "../src/server/context.js";
import { handlePanels } from "../src/server/routes/panels.js";
import {
  handleCheckUpdates,
  handleHold,
  handleUpdateCommand,
} from "../src/server/routes/skill-updates.js";
import { type SynthraPaths, resolvePaths } from "../src/shared/paths.js";

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
const sha = (text: string) => {
  const b = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
};
const h = (c: string) => c.repeat(40);

async function machine(): Promise<{ home: string; paths: SynthraPaths; ctx: ServerContext }> {
  const home = await mkdtemp(join(tmpdir(), "syn-updates-"));
  const project = join(home, "work", "shop");
  await mkdir(project, { recursive: true });
  const paths: SynthraPaths = {
    ...resolvePaths(project, join(home, ".synthra", "USER.md")),
    globalSkillsDir: join(home, ".claude", "skills"),
    skillState: join(home, ".synthra", "skills"),
  };
  const ctx: ServerContext = {
    paths,
    graph: {
      root: "/",
      node_count: 0,
      edge_count: 0,
      file_count: 0,
      symbol_count: 0,
      nodes: [],
      edges: [],
      generated_at: "2026-10-04T00:00:00.000Z",
      schema_version: 1,
    },
    symbolIndex: {},
    activity: new ActivityStore(paths.activityLog),
  };
  return { home, paths, ctx };
}

const entry = (source: string, skillPath: string, hash: string, extra = {}) => ({
  source,
  sourceType: "github",
  sourceUrl: `https://github.com/${source}.git`,
  skillPath,
  skillFolderHash: hash,
  ...extra,
});

async function lock(home: string, skills: Record<string, unknown>): Promise<void> {
  await put(join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 3, skills }));
}

/** A fake GitHub: trees by "source@ref", raw files by "source@ref:path". */
function github(trees: Record<string, unknown>, raws: Record<string, string> = {}) {
  const calls: string[] = [];
  const f: Fetch = async (url) => {
    calls.push(url);
    const api = url.match(
      /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^?]+)/,
    );
    const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/);
    const body = api
      ? trees[`${api[1]}@${decodeURIComponent(api[2] ?? "")}`]
      : raw
        ? raws[`${raw[1]}@${raw[2]}:${raw[3]}`]
        : undefined;
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => String(body),
    };
  };
  return { fetch: f, calls };
}

describe("installed-skill updates", () => {
  it("reads only the GitHub skills of the lock file", async () => {
    const { home, paths } = await machine();
    await lock(home, {
      ok: entry("a/b", "skills/ok/SKILL.md", h("1")),
      local: { source: "./x", sourceType: "local", skillPath: "SKILL.md", skillFolderHash: h("1") },
      nohash: entry("a/b", "skills/nohash/SKILL.md", ""),
      "../evil": entry("a/b", "skills/evil/SKILL.md", h("1")),
      badsource: entry("a/b; rm -rf ~", "skills/x/SKILL.md", h("1")),
    });
    const list = await readLockEntries(join(home, ".agents", ".skill-lock.json"));
    expect(list.map((e) => e.name)).toEqual(["ok"]);
    expect(paths.globalSkillsDir).toContain(home);
  });

  it("asks GitHub once per source and finds updated, current and moved skills", async () => {
    const { home, paths } = await machine();
    await lock(home, {
      fresh: entry("a/skills", "skills/fresh/SKILL.md", h("1")),
      same: entry("a/skills", "skills/same/SKILL.md", h("2")),
      gone: entry("a/skills", "skills/gone/SKILL.md", h("3")),
      lost: entry("b/private", "SKILL.md", h("4")),
    });
    const gh = github({
      "a/skills@HEAD": {
        sha: h("9"),
        tree: [
          { path: "skills/fresh", type: "tree", sha: h("5") },
          { path: "skills/same", type: "tree", sha: h("2") },
        ],
      },
    });
    const r = await checkUpdates(paths, { fetch: gh.fetch, token: null });
    expect(r).toMatchObject({ checked: 3, available: 1, moved: 1 });
    expect(r.errors).toEqual([expect.stringMatching(/^b\/private: not found/)]);
    // One tree for a/skills; b/private tries its three branch names.
    expect(gh.calls.filter((u) => u.includes("a/skills"))).toHaveLength(1);

    let f = await updateFacts(paths);
    expect(Object.fromEntries(f.state)).toEqual({ fresh: "available", gone: "moved" });

    // After `npx skills update fresh`, the lock has the new hash: no update.
    await lock(home, {
      fresh: entry("a/skills", "skills/fresh/SKILL.md", h("5")),
      same: entry("a/skills", "skills/same/SKILL.md", h("2")),
      gone: entry("a/skills", "skills/gone/SKILL.md", h("3")),
    });
    f = await updateFacts(paths);
    expect(Object.fromEntries(f.state)).toEqual({ gone: "moved" });
  });

  it("uses the lock's branch when it has one", async () => {
    const { home, paths } = await machine();
    await lock(home, { x: entry("a/b", "x/SKILL.md", h("1"), { ref: "v2" }) });
    const gh = github({
      "a/b@v2": { sha: h("9"), tree: [{ path: "x", type: "tree", sha: h("1") }] },
    });
    expect(await checkUpdates(paths, { fetch: gh.fetch, token: null })).toMatchObject({
      checked: 1,
      available: 0,
    });
    expect(gh.calls).toEqual([expect.stringContaining("/git/trees/v2?")]);
  });

  it("keeps a 'Don't update' list, and builds the update command only for allowed skills", async () => {
    const { home, paths, ctx } = await machine();
    await lock(home, {
      a: entry("o/r", "a/SKILL.md", h("1")),
      "react:components": entry("o/r", "rc/SKILL.md", h("1")),
    });
    expect(await handleHold({ name: "a", on: true }, ctx)).toEqual({ ok: true });
    expect(await handleHold({ name: "impeccable", on: true }, ctx)).toMatchObject({ ok: false });
    expect((await updateFacts(paths)).held.has("a")).toBe(true);

    expect(await handleUpdateCommand({ names: ["a"] }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Don't update"),
    });
    expect(await handleUpdateCommand({ names: ["react:components"] }, ctx)).toEqual({
      ok: true,
      command: "npx -y skills update react:components -g -y",
    });
    // A name not in the lock (impeccable, your own skills) is never updated.
    expect(
      await handleUpdateCommand({ names: ["react:components", "impeccable"] }, ctx),
    ).toMatchObject({
      ok: false,
    });
    expect(await handleUpdateCommand({ names: ["x; rm -rf ~"] }, ctx)).toMatchObject({ ok: false });

    await setHold(paths.skillState, "a", false);
    expect((await updateFacts(paths)).held.has("a")).toBe(false);
    expect(updateCommand(["a", "b"])).toBe("npx -y skills update a b -g -y");
    expect(updateCommand(["a b"])).toBeNull();
  });

  it("shows what an update changes, and what you changed here", async () => {
    const { home, paths } = await machine();
    const oldSkill = "---\nname: tool\ndescription: Old\n---\n\nOld body\n";
    const newSkill = "---\nname: tool\ndescription: New\n---\n\nNew body\n";
    await lock(home, { tool: entry("o/r", "skills/tool/SKILL.md", h("1")) });
    const dir = join(paths.globalSkillsDir, "tool");
    // The installer wrote Windows line endings: still "not changed here".
    await put(join(dir, "SKILL.md"), oldSkill.replace(/\n/g, "\r\n"));
    await put(join(dir, "references", "a.md"), "mine now");
    await put(join(dir, "notes.md"), "added here");
    const gh = github(
      {
        // The folder as installed.
        [`o/r@${h("1")}`]: {
          sha: h("1"),
          tree: [
            { path: "SKILL.md", type: "blob", sha: sha(oldSkill) },
            { path: "references", type: "tree", sha: h("7") },
            { path: "references/a.md", type: "blob", sha: sha("a") },
            { path: "references/old.md", type: "blob", sha: sha("old") },
          ],
        },
        "o/r@HEAD": {
          sha: h("9"),
          tree: [
            { path: "skills/tool", type: "tree", sha: h("2") },
            { path: "skills/tool/SKILL.md", type: "blob", sha: sha(newSkill) },
            { path: "skills/tool/references/a.md", type: "blob", sha: sha("a") },
            { path: "skills/tool/references/new.md", type: "blob", sha: sha("new") },
          ],
        },
      },
      { "o/r@HEAD:skills/tool/SKILL.md": newSkill },
    );
    const d = await updateDiff(paths, "tool", { fetch: gh.fetch, token: null });
    if (typeof d === "string") throw new Error(d);
    expect(d.after).toBe(newSkill);
    expect(d.before).toBe(oldSkill.replace(/\n/g, "\r\n"));
    expect(d.added).toEqual(["references/new.md"]);
    expect(d.changed).toEqual(["SKILL.md"]);
    expect(d.removed).toEqual(["references/old.md"]);
    expect(d.editedHere).toEqual(["notes.md", "references/a.md", "references/old.md"]);

    expect(await updateDiff(paths, "nope", { fetch: gh.fetch, token: null })).toMatch(
      /isn't a skill installed/,
    );
  });

  it("puts the update state on the Capabilities rows", async () => {
    const { home, paths, ctx } = await machine();
    await lock(home, {
      fresh: entry("a/skills", "skills/fresh/SKILL.md", h("1")),
      kept: entry("a/skills", "skills/kept/SKILL.md", h("1")),
    });
    for (const n of ["fresh", "kept", "mine"]) {
      await put(
        join(paths.globalSkillsDir, n, "SKILL.md"),
        `---\nname: ${n}\ndescription: ${n}\n---\n`,
      );
    }
    const gh = github({
      "a/skills@HEAD": {
        sha: h("9"),
        tree: [
          { path: "skills/fresh", type: "tree", sha: h("5") },
          { path: "skills/kept", type: "tree", sha: h("5") },
        ],
      },
    });
    expect(await handleCheckUpdates(ctx, { fetch: gh.fetch, token: null })).toMatchObject({
      ok: true,
      available: 2,
    });
    await setHold(paths.skillState, "kept", true);
    const p = await handlePanels(ctx, { homeDir: home, fresh: true });
    const row = (n: string) => p.capabilities.skills.find((s) => s.name === n);
    expect(row("fresh")).toMatchObject({
      third_party: "a/skills",
      updatable: "fresh",
      update: "available",
    });
    expect(row("kept")).toMatchObject({ updatable: "kept", held: true });
    expect(row("kept")?.update).toBeUndefined();
    expect(row("mine")?.updatable).toBeUndefined();
    expect(p.capabilities.updates?.checked_at).toMatch(/^\d{4}-/);
    expect(
      JSON.parse(await readFile(join(paths.skillState, "updates.json"), "utf8")),
    ).toHaveProperty("skills.fresh.latest", h("5"));
  });
});
