// The skill writer (src/learn/skills.ts + the skill_manage MCP tool): skills
// in Claude Code's own folders, marked as Synthra's, changed only after a
// view, and — by default — waiting for the user's OK.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import { computeArsenal } from "../src/dashboard/arsenal.js";
import {
  SUPPORT_MAX,
  __resetViewed,
  approveProposal,
  archiveMerged,
  checkDraft,
  checkSupportPath,
  createSkill,
  editSkill,
  findSkill,
  listPending,
  listSupportFiles,
  markViewed,
  parseSkill,
  patchSkill,
  readBlob,
  readLedger,
  rejectProposal,
  removeSupportFile,
  renderSkill,
  skillLockPath,
  viewSupportFile,
  writeSupportFile,
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

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
});

/** A skill the user wrote by hand, not Synthra. */
async function userSkill(
  paths: SynthraPaths,
  name: string,
  text: string,
  scope: "project" | "global" = "project",
): Promise<string> {
  const dir = join(scope === "project" ? paths.projectSkillsDir : paths.globalSkillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), text, "utf8");
  return join(dir, "SKILL.md");
}

const deploy = "---\nname: deploy\ndescription: Ship it\nallowed-tools: Bash\n---\n\nSteps\n";

describe("the user's own skills", () => {
  async function viewed(paths: SynthraPaths, name: string) {
    const s = await findSkill(paths, name);
    markViewed(s!.path);
    return s!;
  }

  // Update first: Claude may improve the user's skills too, but never behind
  // their back, and never by rewriting the file into Synthra's format.
  it("waits for the OK even with approval off, and lands byte for byte", async () => {
    const paths = await setup();
    live();
    const file = await userSkill(paths, "deploy", deploy);
    await viewed(paths, "deploy");
    const o = await patchSkill(paths, {
      name: "deploy",
      old_string: "Steps",
      new_string: "1. Build.\n2. Ship.",
    });
    expect(o).toMatchObject({ status: "pending", always: true, proposal: { owner: "user" } });
    expect(await readFile(file, "utf8")).toBe(deploy);

    const [p] = await listPending(paths.skillState);
    expect(await approveProposal(paths.skillState, p!.id)).toMatchObject({ ok: true });
    const after = await readFile(file, "utf8");
    expect(after).toBe(deploy.replace("Steps", "1. Build.\n2. Ship."));
    expect(after).not.toContain("synthra: learned");
  });

  it("may change the description, but no other frontmatter", async () => {
    const paths = await setup();
    await userSkill(paths, "deploy", deploy);
    await viewed(paths, "deploy");
    const ok = await patchSkill(paths, {
      name: "deploy",
      old_string: "description: Ship it",
      new_string: "description: Use when shipping. Builds, then ships.",
    });
    expect(ok.status).toBe("pending");

    const refused = (old_string: string, new_string: string) =>
      patchSkill(paths, { name: "deploy", old_string, new_string });
    for (const [o, n] of [
      ["name: deploy", "name: ship"],
      ["allowed-tools: Bash", "allowed-tools: Bash, Write"],
      ["allowed-tools: Bash", "allowed-tools: Bash\nmodel: opus"],
    ] as const) {
      expect(((await refused(o, n)) as { error: string }).error).toMatch(/description only/);
    }
    expect(((await refused("\n---\n\nSteps", "\n\nSteps")) as { error: string }).error).toMatch(
      /breaks the skill's frontmatter/,
    );
  });

  it("refuses a full rewrite", async () => {
    const paths = await setup();
    await userSkill(paths, "deploy", deploy);
    await viewed(paths, "deploy");
    const o = await editSkill(paths, { name: "deploy", body: "All new" });
    expect((o as { error: string }).error).toMatch(/full rewrite isn't allowed/);
  });

  it("keeps CRLF line ends", async () => {
    const paths = await setup();
    live();
    const crlf = "---\r\nname: crlf\r\ndescription: x\r\n---\r\n\r\nStep one\r\nStep two\r\n";
    const file = await userSkill(paths, "crlf", crlf);
    await viewed(paths, "crlf");
    await patchSkill(paths, {
      name: "crlf",
      old_string: "Step one\nStep two",
      new_string: "Step one\nStep 2",
    });
    const [p] = await listPending(paths.skillState);
    await approveProposal(paths.skillState, p!.id);
    expect(await readFile(file, "utf8")).toBe(crlf.replace("Step two", "Step 2"));
  });

  // An installer (npx skills) would overwrite the change, so nobody edits it.
  it("never changes a skill an installer put there", async () => {
    const paths = await setup();
    live();
    await writeJson(skillLockPath(paths, "global"), {
      skills: { "ask-sonner": { source: "emilkowalski/skills" } },
    });
    await userSkill(paths, "ask-sonner", deploy.replace("deploy", "ask-sonner"), "global");
    await viewed(paths, "ask-sonner");
    const o = await patchSkill(paths, {
      name: "ask-sonner",
      old_string: "Steps",
      new_string: "More",
    });
    expect((o as { error: string }).error).toMatch(/installed from emilkowalski\/skills/);
  });

  it("finds a skill only by its exact folder name", async () => {
    const paths = await setup();
    await userSkill(paths, "deploy", deploy);
    expect(await findSkill(paths, "../deploy")).toBeNull();
    expect(await findSkill(paths, "Deploy")).toBeNull();
    expect(await findSkill(paths, "deploy")).not.toBeNull();
  });
});

describe("support files", () => {
  async function synthraSkill(paths: SynthraPaths) {
    const before = process.env.SYN_SKILL_APPROVAL;
    live();
    await createSkill(paths, { scope: "project", ...release });
    if (before === undefined) delete process.env.SYN_SKILL_APPROVAL;
    else process.env.SYN_SKILL_APPROVAL = before;
    const s = await findSkill(paths, release.name);
    markViewed(s!.path);
    return dirname(s!.path);
  }
  const write = (paths: SynthraPaths, file_path: string, content: string) =>
    writeSupportFile(paths, { name: release.name, file_path, content });

  it("allows topical files under references/, templates/ and scripts/ only", () => {
    for (const ok of [
      "references/forms.md",
      "templates/page.html",
      "scripts/check.sh",
      "references/a/b.md",
    ]) {
      expect(checkSupportPath(ok)).toBeNull();
    }
    for (const bad of [
      "",
      "/etc/x.md",
      "C:x.md",
      "../x.md",
      "references/../x.md",
      "references/.hidden.md",
      "SKILL.md",
      "references/SKILL.md",
      "notes/x.md",
      "references",
      "references/x.exe",
      "references/con.md",
      "references/a/b/c/d.md",
    ]) {
      expect(checkSupportPath(bad)).not.toBeNull();
    }
    // Reading may open any file in the folder (impeccable keeps reference/).
    expect(checkSupportPath("reference/x.md", true)).toBeNull();
  });

  it("adds a file after a view, lists it, and changes it only after viewing it", async () => {
    const paths = await setup();
    live();
    const dir = await synthraSkill(paths);
    __resetViewed();
    expect(
      ((await write(paths, "references/forms.md", "# Forms")) as { error: string }).error,
    ).toMatch(/View "release-checklist" first/);
    markViewed(join(dir, "SKILL.md"));
    expect((await write(paths, "references/forms.md", "# Forms\n")).status).toBe("applied");
    expect(await readFile(join(dir, "references", "forms.md"), "utf8")).toBe("# Forms\n");
    expect(await listSupportFiles(dir)).toEqual({ files: ["references/forms.md"], more: 0 });

    __resetViewed();
    markViewed(join(dir, "SKILL.md"));
    expect(
      ((await write(paths, "references/forms.md", "# New")) as { error: string }).error,
    ).toMatch(/View references\/forms.md/);
    expect(
      await viewSupportFile(paths, release.name, undefined, "references/forms.md"),
    ).toMatchObject({
      text: "# Forms\n",
    });
    expect((await write(paths, "references/forms.md", "# New\n")).status).toBe("applied");

    const patched = await patchSkill(paths, {
      name: release.name,
      file_path: "references/forms.md",
      old_string: "New",
      new_string: "Newer",
    });
    expect(patched.status).toBe("applied");
    expect(await readFile(join(dir, "references", "forms.md"), "utf8")).toBe("# Newer\n");
  });

  it("refuses a secret, a file that is too big, and a path out through a link", async () => {
    const paths = await setup();
    live();
    const dir = await synthraSkill(paths);
    expect(
      ((await write(paths, "references/a.md", `key sk-${"a".repeat(30)}`)) as { error: string })
        .error,
    ).toMatch(/secret/);
    expect(
      ((await write(paths, "references/a.md", "x".repeat(SUPPORT_MAX + 1))) as { error: string })
        .error,
    ).toMatch(/limit/);
    const outside = await mkdtemp(join(tmpdir(), "syn-outside-"));
    try {
      await symlink(
        outside,
        join(dir, "templates"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return; // no links on this machine
    }
    const o = await write(paths, "templates/x.md", "hi");
    expect((o as { error: string }).error).toMatch(/leaves the skill's folder/);
  });

  it("always waits for the OK on a script", async () => {
    const paths = await setup();
    live();
    await synthraSkill(paths);
    expect(await write(paths, "scripts/check.sh", "echo ok\n")).toMatchObject({
      status: "pending",
      always: true,
    });
  });

  it("removes a file, recorded with its path", async () => {
    const paths = await setup();
    live();
    const dir = await synthraSkill(paths);
    await write(paths, "references/a.md", "a\n");
    const o = await removeSupportFile(paths, { name: release.name, file_path: "references/a.md" });
    expect(o.status).toBe("applied");
    expect(await listSupportFiles(dir)).toEqual({ files: [], more: 0 });
    const last = (await readLedger(paths.skillState)).at(-1);
    expect(last).toMatchObject({ action: "remove", file: "references/a.md" });
  });

  it("never brings back a skill that was deleted while a file waited", async () => {
    const paths = await setup();
    const dir = await synthraSkill(paths);
    await write(paths, "references/a.md", "a\n");
    const [p] = await listPending(paths.skillState);
    await rm(dir, { recursive: true, force: true });
    const a = await approveProposal(paths.skillState, p!.id);
    expect((a as { error: string }).error).toMatch(/isn't there any more/);
  });
});

describe("one waiting change per file", () => {
  it("folds a second change into the waiting one, and drops one that undoes it", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    delete process.env.SYN_SKILL_APPROVAL; // approval on again
    const s = await findSkill(paths, release.name);
    markViewed(s!.path);
    await patchSkill(paths, { name: release.name, old_string: "3. Tag", new_string: "3. Push" });
    await patchSkill(paths, {
      name: release.name,
      old_string: "3. Push",
      new_string: "3. Push tags",
    });
    const waiting = await listPending(paths.skillState);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.after).toContain("3. Push tags");

    const undo = await patchSkill(paths, {
      name: release.name,
      old_string: "3. Push tags",
      new_string: "3. Tag",
    });
    expect(undo.status).toBe("dropped");
    expect(await listPending(paths.skillState)).toEqual([]);
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
    const made = await call(c, {
      action: "create",
      scope: "project",
      ...release,
      reason: "No skill covers releases yet.",
    });
    expect(made.isError).toBe(false);
    expect(made.text).toContain("waiting for the user's OK");
    expect((await call(c, { action: "list" })).text).toContain("Waiting for the user's OK: 1");

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

  // Create is the last step: Claude must say which skills it checked first.
  it("refuses a create without a reason", async () => {
    const r = await call(await ctx(), { action: "create", scope: "project", ...release });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/which existing skills you checked/);
  });

  it("says who owns a skill, and lists its support files", async () => {
    const c = await ctx();
    const file = await userSkill(c.paths, "deploy", deploy);
    await writeFile(join(dirname(file), "notes.md"), "n", "utf8");
    const v = await call(c, { action: "view", name: "deploy" });
    expect(v.text).toContain("The user's own skill");
    expect(v.text).toContain("Support files (1): notes.md");
    expect((await call(c, { action: "list" })).text).toContain("the user's own");
    const f = await call(c, { action: "view", name: "deploy", file_path: "notes.md" });
    expect(f.text).toContain("n");
  });
});

describe("review fixes", () => {
  it("won't let a patch add frontmatter, and keeps the frontmatter canonical", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    const o = await patchSkill(paths, {
      name: release.name,
      old_string: "metadata:",
      new_string: "allowed-tools: Bash\nmetadata:",
    });
    expect(o).toMatchObject({ status: "error" });
    expect((o as { error: string }).error).toMatch(/allowed-tools/);
  });

  it("lists proposals made in the same millisecond in a fixed order", async () => {
    const paths = await setup();
    await createSkill(paths, { scope: "project", ...release, name: "b-skill" });
    await createSkill(paths, { scope: "project", ...release, name: "a-skill" });
    const ids = (await listPending(paths.skillState)).map((p) => p.id);
    const again = (await listPending(paths.skillState)).map((p) => p.id);
    expect(again).toEqual(ids);
  });
});

describe("merging: archive into an umbrella", () => {
  it("needs a real umbrella, never itself, and never an installed skill", async () => {
    const paths = await setup();
    live();
    await createSkill(paths, { scope: "project", ...release });
    const s = await findSkill(paths, release.name);
    markViewed(s!.path);
    const err = async (absorbed_into: string) =>
      ((await archiveMerged(paths, { name: release.name, absorbed_into })) as { error: string })
        .error;
    expect(await err("")).toMatch(/absorbed_into/);
    expect(await err(release.name)).toMatch(/itself/);
    expect(await err("nowhere")).toMatch(/Create or patch "nowhere" first/);

    await writeJson(skillLockPath(paths, "global"), {
      skills: { "ask-sonner": { source: "emilkowalski/skills" } },
    });
    await userSkill(paths, "ask-sonner", deploy.replace("deploy", "ask-sonner"), "global");
    markViewed((await findSkill(paths, "ask-sonner"))!.path);
    const third = await archiveMerged(paths, { name: "ask-sonner", absorbed_into: release.name });
    expect((third as { error: string }).error).toMatch(/installed from/);
  });

  it("archives a user's skill only after the OK, and only once the umbrella holds it", async () => {
    const paths = await setup();
    live();
    await userSkill(paths, "deploy", deploy);
    markViewed((await findSkill(paths, "deploy"))!.path);
    // The umbrella waits too (approval on for it).
    delete process.env.SYN_SKILL_APPROVAL;
    await createSkill(paths, { scope: "project", ...release, name: "shipping" });
    live();
    const o = await archiveMerged(paths, { name: "deploy", absorbed_into: "shipping" });
    expect(o).toMatchObject({
      status: "pending",
      always: true,
      proposal: { absorbedInto: "shipping" },
    });
    const archive = (await listPending(paths.skillState)).find((p) => p.action === "archive");
    const early = await approveProposal(paths.skillState, archive!.id);
    expect((early as { error: string }).error).toMatch(/Approve the change to "shipping" first/);
  });
});
