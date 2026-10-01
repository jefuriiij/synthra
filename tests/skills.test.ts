// The skill writer (src/learn/skills.ts + the skill_manage MCP tool): skills
// in Claude Code's own folders, marked as Synthra's, changed only after a
// view, and — by default — waiting for the user's OK.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import { computeArsenal } from "../src/dashboard/arsenal.js";
import {
  __resetViewed,
  approveProposal,
  checkDraft,
  createSkill,
  editSkill,
  findSkill,
  listPending,
  markViewed,
  parseSkill,
  patchSkill,
  readBlob,
  readLedger,
  rejectProposal,
  renderSkill,
} from "../src/learn/skills.js";
import type { ServerContext } from "../src/server/context.js";
import { handleMcpRequest } from "../src/server/mcp.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

async function setup(): Promise<SynthraPaths> {
  const root = await mkdtemp(join(tmpdir(), "syn-skills-"));
  const project = join(root, "aster");
  await mkdir(project);
  const base = resolvePaths(project);
  return {
    ...base,
    globalSkillsDir: join(root, "home", ".claude", "skills"),
    skillState: join(root, "home", ".synthra", "skills"),
  };
}

beforeEach(() => {
  __resetViewed();
  delete process.env.SYN_SKILL_APPROVAL;
});
afterEach(() => {
  delete process.env.SYN_SKILL_APPROVAL;
});

const live = () => (process.env.SYN_SKILL_APPROVAL = "0");

const release = {
  name: "release-checklist",
  description: "Use when cutting a release. Bumps the version, updates the changelog, tags.",
  body: "1. Bump package.json.\n2. Add a CHANGELOG entry.\n3. Tag vX.Y.Z.",
};

describe("the SKILL.md Synthra writes", () => {
  it("has name, description and Synthra's mark, and reads back the same", () => {
    const text = renderSkill({ ...release, origin: "aster" });
    expect(text.startsWith("---\nname: release-checklist\n")).toBe(true);
    expect(parseSkill(text)).toMatchObject({
      name: "release-checklist",
      description: release.description,
      learned: true,
      origin: "aster",
    });
  });

  it("quotes a description only when it must, and still reads it back", () => {
    const d = 'Use when: the build says "EPERM". Clears the cache.';
    const text = renderSkill({ ...release, description: d });
    expect(text).toContain(
      'description: "Use when: the build says \\"EPERM\\". Clears the cache."',
    );
    expect(parseSkill(text).description).toBe(d);
  });

  it("is listed by the arsenal like any other skill", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    const a = await computeArsenal(paths.projectRoot, join(paths.globalSkillsDir, "..", ".."));
    expect(a.skills.map((s) => [s.name, s.description])).toEqual([
      ["release-checklist", release.description],
    ]);
  });

  it("refuses bad names, empty or multi-line descriptions, and secrets", () => {
    expect(checkDraft({ ...release, name: "Release Checklist" })).toMatch(/lowercase/);
    expect(checkDraft({ ...release, description: "" })).toMatch(/required/);
    expect(checkDraft({ ...release, description: "a\nb" })).toMatch(/one line/);
    expect(
      checkDraft({ ...release, body: "export TOKEN = ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
    ).toMatch(/secret/);
    expect(checkDraft(release)).toBeNull();
  });
});

describe("with approval off: live at once", () => {
  it("writes a project skill, records it, and keeps the text for a diff", async () => {
    const paths = await setup();
    live();
    const o = await createSkill(paths, { scope: "project", ...release, reason: "Asked twice" });
    expect(o.status).toBe("applied");
    const file = join(paths.projectSkillsDir, "release-checklist", "SKILL.md");
    expect(await readFile(file, "utf8")).toContain("synthra: learned");
    const [e] = await readLedger(paths.skillState);
    expect(e).toMatchObject({
      action: "create",
      actor: "agent",
      scope: "project",
      reason: "Asked twice",
    });
    expect(await readBlob(paths.skillState, e!.afterSha!)).toContain("Bump package.json");
  });

  it("writes a global skill with the project it came from", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "global", ...release });
    const s = await findSkill(paths, "release-checklist", "global");
    expect(parseSkill(s!.text).origin).toBe("aster");
  });

  it("won't create over an existing skill", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    const again = await createSkill(paths, { scope: "project", ...release });
    expect(again).toMatchObject({ status: "error" });
  });
});

describe("changing a skill", () => {
  it("needs a view first, then patches one exact piece", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    __resetViewed(); // a new server: nothing viewed yet
    const blind = await patchSkill(paths, {
      name: release.name,
      old_string: "Tag",
      new_string: "Push the tag",
    });
    expect(blind).toMatchObject({ status: "error" });
    expect((blind as { error: string }).error).toMatch(/View/);

    markViewed((await findSkill(paths, release.name))!.path);
    const o = await patchSkill(paths, {
      name: release.name,
      old_string: "3. Tag",
      new_string: "3. Push the tag",
    });
    expect(o.status).toBe("applied");
    expect((await findSkill(paths, release.name))!.text).toContain("3. Push the tag vX.Y.Z.");
  });

  it("refuses a patch that matches twice, or would drop the mark or the name", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    expect(
      await patchSkill(paths, { name: release.name, old_string: ".", new_string: "!" }),
    ).toMatchObject({ status: "error" });
    expect(
      await patchSkill(paths, {
        name: release.name,
        old_string: "  synthra: learned\n",
        new_string: "",
      }),
    ).toMatchObject({ status: "error" });
    expect(
      await patchSkill(paths, {
        name: release.name,
        old_string: "name: release-checklist",
        new_string: "name: other",
      }),
    ).toMatchObject({ status: "error" });
  });

  it("rewrites the description and keeps the name, mark and origin", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "global", ...release });
    const o = await editSkill(paths, {
      name: release.name,
      scope: "global",
      description: "Use when shipping. Runs the release steps.",
    });
    expect(o.status).toBe("applied");
    const p = parseSkill((await findSkill(paths, release.name, "global"))!.text);
    expect(p).toMatchObject({
      name: release.name,
      learned: true,
      origin: "aster",
      description: "Use when shipping. Runs the release steps.",
    });
  });

  // "Synthra changes only the skills that it made."
  it("never changes a skill it didn't write", async () => {
    const paths = await setup();
    live();
    const dir = join(paths.projectSkillsDir, "deploy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: deploy\ndescription: Ship it\n---\nSteps\n",
      "utf8",
    );
    const s = await findSkill(paths, "deploy");
    markViewed(s!.path);
    const o = await patchSkill(paths, { name: "deploy", old_string: "Steps", new_string: "More" });
    expect((o as { error: string }).error).toMatch(/wasn't written by Synthra/);
  });
});

describe("with approval on (the default): proposals", () => {
  it("parks a new skill until the user approves it", async () => {
    const paths = await setup();
    const o = await createSkill(paths, { scope: "project", ...release });
    expect(o.status).toBe("pending");
    expect(await findSkill(paths, release.name)).toBeNull();
    const [p] = await listPending(paths.skillState);
    expect(p).toMatchObject({ action: "create", name: release.name, before: null });

    const a = await approveProposal(paths.skillState, p!.id);
    expect(a).toMatchObject({ ok: true, event: { action: "create", approved: true } });
    expect(await findSkill(paths, release.name)).not.toBeNull();
    expect(await listPending(paths.skillState)).toEqual([]);
  });

  it("drops a rejected proposal and records the no", async () => {
    const paths = await setup();
    await createSkill(paths, { scope: "project", ...release });
    const [p] = await listPending(paths.skillState);
    expect(await rejectProposal(paths.skillState, p!.id)).toMatchObject({ ok: true });
    expect(await listPending(paths.skillState)).toEqual([]);
    expect((await readLedger(paths.skillState)).map((e) => [e.action, e.actor])).toEqual([
      ["reject", "user"],
    ]);
    expect(await findSkill(paths, release.name)).toBeNull();
  });

  it("won't apply a change to a file that moved on since", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    delete process.env.SYN_SKILL_APPROVAL; // approval on again
    await patchSkill(paths, { name: release.name, old_string: "3. Tag", new_string: "3. Push" });
    const [p] = await listPending(paths.skillState);
    const file = join(paths.projectSkillsDir, release.name, "SKILL.md");
    await writeFile(file, (await readFile(file, "utf8")) + "\nEdited by hand.\n", "utf8");
    const a = await approveProposal(paths.skillState, p!.id);
    expect(a).toMatchObject({ ok: false });
    expect((a as { error: string }).error).toMatch(/changed since/);
  });

  it("ignores an id that isn't a proposal", async () => {
    const paths = await setup();
    expect(await approveProposal(paths.skillState, "../../etc/passwd")).toMatchObject({
      ok: false,
    });
  });
});

describe("the skill_manage tool", () => {
  async function ctx(): Promise<ServerContext> {
    const paths = await setup();
    return {
      paths,
      graph: {
        root: paths.projectRoot,
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
  const call = async (c: ServerContext, args: Record<string, unknown>) => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "skill_manage", arguments: args },
      },
      c,
    );
    const r = res.result as { content: { text: string }[]; isError: boolean };
    return { text: r.content[0]?.text ?? "", isError: r.isError };
  };

  it("creates (waiting for OK), lists what waits, then views and patches once live", async () => {
    const c = await ctx();
    const made = await call(c, { action: "create", scope: "project", ...release });
    expect(made.isError).toBe(false);
    expect(made.text).toContain("waiting for the user's OK");
    expect((await call(c, { action: "list" })).text).toContain("Waiting for the user's OK — 1");

    const [p] = await listPending(c.paths.skillState);
    await approveProposal(c.paths.skillState, p!.id);
    __resetViewed();
    expect(
      (
        await call(c, {
          action: "patch",
          name: release.name,
          old_string: "Tag",
          new_string: "Push",
        })
      ).text,
    ).toMatch(/View/);
    const viewed = await call(c, { action: "view", name: release.name });
    expect(viewed.text).toContain("Written by Synthra");
    expect(viewed.text).toContain("1. Bump package.json.");
  });

  it("asks for a scope on create", async () => {
    const r = await call(await ctx(), { action: "create", ...release });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scope/);
  });
});
