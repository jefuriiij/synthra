// The Learning tab: what the server reports (proposals, recent changes, the
// skills Synthra wrote), the approve/reject routes, and how the sidebar and
// the large panel show it.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTabs } from "../extension/src/panelTabs.js";
import { learningView, type PanelsPayload } from "../extension/src/panelTrees.js";
import { ActivityStore } from "../src/activity/activity-log.js";
import {
  __resetViewed,
  writeSupportFile,
  createSkill,
  listPending,
  markViewed,
  patchSkill,
  readLedger,
  restoreSkill,
  skillLockPath,
} from "../src/learn/skills.js";
import { readPins, setPin } from "../src/learn/curator.js";
import { handleDelete } from "../src/server/routes/learning.js";
import type { ServerContext } from "../src/server/context.js";
import { startServer } from "../src/server/http.js";
import { handlePanels } from "../src/server/routes/panels.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const skill = {
  name: "release-checklist",
  description: "Use when cutting a release. Bumps, logs, tags.",
  body: "1. Bump.\n2. Log.\n3. Tag.",
};

async function setup(): Promise<SynthraPaths> {
  const root = await mkdtemp(join(tmpdir(), "syn-learning-"));
  const project = join(root, "aster");
  await mkdir(project);
  return {
    ...resolvePaths(project),
    globalSkillsDir: join(root, "home", ".claude", "skills"),
    skillState: join(root, "home", ".synthra", "skills"),
  };
}

const ctxOf = (paths: SynthraPaths): ServerContext => ({
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
});

beforeEach(() => {
  __resetViewed();
  delete process.env.SYN_SKILL_APPROVAL;
});
afterEach(() => {
  delete process.env.SYN_SKILL_APPROVAL;
});

describe("GET /panels — learning", () => {
  it("reports proposals with their texts, and flags one whose file moved on", async () => {
    const paths = await setup();
    process.env.SYN_SKILL_APPROVAL = "0";
    await createSkill(paths, { scope: "project", ...skill });
    delete process.env.SYN_SKILL_APPROVAL;
    markViewed(join(paths.projectSkillsDir, skill.name, "SKILL.md"));
    await patchSkill(paths, {
      name: skill.name,
      old_string: "3. Tag.",
      new_string: "3. Push the tag.",
      reason: "Tags must be pushed",
    });

    let p = await handlePanels(ctxOf(paths));
    expect(p.learning?.approval).toBe(true);
    expect(p.learning?.pending).toEqual([
      expect.objectContaining({
        action: "patch",
        name: skill.name,
        reason: "Tags must be pushed",
        stale: false,
      }),
    ]);
    expect(p.learning?.pending[0]?.after).toContain("3. Push the tag.");
    expect(p.learning?.recent.map((e) => e.action)).toEqual(["create"]);
    expect(p.learning?.learned.map((s) => [s.name, s.scope])).toEqual([[skill.name, "project"]]);

    await writeFile(
      join(paths.projectSkillsDir, skill.name, "SKILL.md"),
      "changed by hand",
      "utf8",
    );
    p = await handlePanels(ctxOf(paths));
    expect(p.learning?.pending[0]?.stale).toBe(true);
  });
});

describe("POST /skills/approve and /skills/reject", () => {
  it("applies or drops a proposal, and serves the stored texts for diffs", async () => {
    const paths = await setup();
    await createSkill(paths, { scope: "project", ...skill });
    await createSkill(paths, { scope: "global", ...skill, name: "other-skill" });
    // By name: two proposals made in the same millisecond have no meaningful order.
    const pending = await listPending(paths.skillState);
    const a = pending.find((p) => p.name === skill.name);
    const b = pending.find((p) => p.name === "other-skill");
    const handle = await startServer(paths, { version: "test" });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const post = async (route: string, id: string) =>
        (await (
          await fetch(`${base}${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
          })
        ).json()) as { ok: boolean; error?: string };

      expect(await post("/skills/approve", a!.id)).toEqual({ ok: true });
      expect(await post("/skills/reject", b!.id)).toEqual({ ok: true });
      expect((await post("/skills/approve", b!.id)).ok).toBe(false);

      const panels = (await (await fetch(`${base}/panels`)).json()) as PanelsPayload;
      expect(panels.learning?.pending).toEqual([]);
      expect(panels.learning?.recent.map((e) => [e.action, e.name])).toEqual([
        ["reject", "other-skill"],
        ["create", skill.name],
      ]);
      const sha = panels.learning?.recent[1]?.afterSha;
      const blob = (await (await fetch(`${base}/skills/blob?sha=${sha}`)).json()) as {
        text: string;
      };
      expect(blob.text).toContain("1. Bump.");
      expect(await (await fetch(`${base}/skills/blob?sha=../../x`)).json()).toEqual({
        found: false,
      });
    } finally {
      await handle.stop();
    }
  });
});

describe("the Learning views", () => {
  const now = Date.parse("2026-10-02T12:00:00.000Z");
  const learning: NonNullable<PanelsPayload["learning"]> = {
    approval: true,
    pending: [
      {
        id: "abc-123456",
        ts: "2026-10-02T11:00:00.000Z",
        action: "create",
        scope: "global",
        name: "fix-eperm",
        path: "/home/me/.claude/skills/fix-eperm/SKILL.md",
        description: "Use when npm says EPERM.",
        reason: "Took three tries",
        before: null,
        after: "---\nname: fix-eperm\n---\nSteps",
        stale: false,
      },
    ],
    recent: [
      {
        id: "x-1",
        ts: "2026-10-01T10:00:00.000Z",
        action: "patch",
        actor: "agent",
        approved: true,
        scope: "project",
        name: "release-checklist",
        path: "/p/.claude/skills/release-checklist/SKILL.md",
        beforeSha: "a".repeat(40),
        afterSha: "b".repeat(40),
      },
      {
        id: "x-0",
        ts: "2026-09-01T10:00:00.000Z",
        action: "create",
        actor: "agent",
        scope: "project",
        name: "release-checklist",
        path: "/p/.claude/skills/release-checklist/SKILL.md",
        afterSha: "c".repeat(40),
      },
    ],
    learned: [
      {
        name: "release-checklist",
        scope: "project",
        path: "/p/.claude/skills/release-checklist/SKILL.md",
        description: "Use when releasing.",
      },
    ],
  };
  const payload: PanelsPayload = {
    version: 1,
    project_root: "/p",
    memory: { branch: "main", store_path: "", context_md_path: "", entries: [] },
    capabilities: { skills: [], agents: [], mcp: [], scanned_at: "" },
    agents: { since: "", delegations: [] },
    learning,
  };

  it("sidebar: waiting first, with the ✓/✗ tag and a diff; then recent; then the skills", () => {
    const v = learningView(payload, now);
    expect(v.nodes.map((n) => n.label)).toEqual([
      "Waiting for your OK",
      "Recent changes",
      "Skills Synthra wrote",
    ]);
    const p = v.nodes[0]?.children?.[0];
    expect(p).toMatchObject({ id: "learn:pending:abc-123456", contextValue: "synthraProposal" });
    expect(p?.description).toBe("New skill · all projects · 1 h ago");
    expect(p?.open).toMatchObject({
      kind: "diff",
      before: null,
      after: { text: learning.pending[0]!.after },
    });
    expect(v.nodes[1]?.children?.[0]?.open).toMatchObject({
      kind: "diff",
      before: { sha: "a".repeat(40) },
      after: { sha: "b".repeat(40) },
    });
  });

  it("large panel: counts the week's work and hands out keys for every diff", () => {
    const { view, targets } = buildTabs("/p", payload, now);
    const l = view.learning!;
    expect([l.newThisWeek, l.improvedThisWeek]).toEqual([0, 1]);
    expect(l.pending[0]).toMatchObject({
      id: "abc-123456",
      name: "fix-eperm",
      reason: "Took three tries",
    });
    expect(targets.get(l.pending[0]!.diff)).toMatchObject({ kind: "diff", name: "fix-eperm" });
    expect(targets.get(l.recent[0]!.key!)).toMatchObject({ kind: "diff" });
    expect(targets.get(l.learned[0]!.key)).toEqual({
      kind: "file",
      path: "/p/.claude/skills/release-checklist/SKILL.md",
    });
  });

  it("shows the Curator: its last run, stale and archived skills, with their buttons", () => {
    const withCurator: PanelsPayload = {
      ...payload,
      learning: {
        ...learning,
        curator: {
          enabled: true,
          lastRun: {
            ranAt: "2026-09-30T12:00:00.000Z",
            checked: 3,
            stale: 1,
            proposed: 0,
            archived: 1,
          },
          nextRunAt: "2026-10-07T12:00:00.000Z",
          staleDays: 14,
          archiveDays: 30,
          stale: [
            {
              name: "old-one",
              scope: "project",
              path: "/p/.claude/skills/old-one/SKILL.md",
              daysUnused: 20,
              pinned: false,
            },
          ],
          pinned: [{ name: "keeper", scope: "global", path: "/h/.claude/skills/keeper/SKILL.md" }],
          archived: [
            {
              name: "gone",
              scope: "global",
              path: "/h/.claude/skills/gone/SKILL.md",
              archivePath: "/h/.synthra/skills/archive/gone",
              archivedAt: "2026-09-30T12:00:00.000Z",
              project: "/p",
            },
          ],
        },
      },
    };
    const v = learningView(withCurator, now);
    const cur = v.nodes.find((n) => n.id === "learn:curator");
    expect(cur?.description).toBe("on · weekly · last run 2 days ago · 1 stale, 1 archived");
    expect(cur?.contextValue).toBe("synthraCurator");
    expect(cur?.children?.map((n) => [n.label, n.contextValue])).toEqual([
      ["old-one", "synthraStaleSkill"],
      ["gone", "synthraArchivedSkill"],
      ["keeper", "synthraPinnedSkill"],
    ]);
    expect(cur?.children?.[1]?.id).toBe("learn:archived:/h/.synthra/skills/archive/gone");

    const { view, targets } = buildTabs("/p", withCurator, now);
    const card = view.learning!.curator!;
    expect(card).toMatchObject({
      enabled: true,
      lastRun: "2 days ago · 1 stale, 1 archived",
      staleDays: 14,
    });
    expect(targets.get(card.archived[0]!.key)).toEqual({
      kind: "file",
      path: join("/h/.synthra/skills/archive/gone", "SKILL.md"),
    });
  });

  it("says when the server can't learn yet", () => {
    expect(learningView({ version: 1 } as unknown as PanelsPayload, now).message).toMatch(/0\.33/);
  });
});

describe("one project's Learning", () => {
  it("shows its own and global proposals, never another project's", async () => {
    const a = await setup();
    const b = {
      ...resolvePaths(join(a.projectRoot, "..", "other")),
      globalSkillsDir: a.globalSkillsDir,
      skillState: a.skillState,
    };
    await mkdir(b.projectRoot, { recursive: true });
    await createSkill(a, { scope: "project", ...skill, name: "only-in-a" });
    await createSkill(a, { scope: "global", ...skill, name: "everywhere" });
    const seen = await handlePanels(ctxOf(b));
    expect(seen.learning?.pending.map((p) => p.name)).toEqual(["everywhere"]);
    // And it can't be approved from the wrong project.
    const [mine] = (await listPending(a.skillState)).filter((p) => p.name === "only-in-a");
    const { handleAnswer } = await import("../src/server/routes/learning.js");
    expect(await handleAnswer("approve", { id: mine!.id }, ctxOf(b))).toMatchObject({ ok: false });
  });
});

describe("GET /panels: changes to support files and to the user's own skills", () => {
  it("names the file and the owner, and goes stale when the skill is gone", async () => {
    const paths = await setup();
    const dir = join(paths.projectSkillsDir, "deploy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: deploy\ndescription: Ship it\n---\nSteps\n",
      "utf8",
    );
    markViewed(join(dir, "SKILL.md"));
    await writeSupportFile(paths, {
      name: "deploy",
      file_path: "references/checks.md",
      content: "# Checks\n",
    });

    let p = await handlePanels(ctxOf(paths));
    expect(p.learning?.pending).toEqual([
      expect.objectContaining({
        action: "create",
        name: "deploy",
        file: "references/checks.md",
        owner: "user",
        description: "Ship it",
        stale: false,
      }),
    ]);

    await rm(dir, { recursive: true, force: true });
    p = await handlePanels(ctxOf(paths));
    expect(p.learning?.pending[0]?.stale).toBe(true);
  });
});

// The Capabilities tab's Delete: the user confirmed it in the IDE, so it moves
// to the archive now, and Restore brings it back.
describe("POST /skills/delete", () => {
  const userSkill = async (paths: SynthraPaths, name: string, scope: "project" | "global") => {
    const dir = join(scope === "project" ? paths.projectSkillsDir : paths.globalSkillsDir, name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    await writeFile(file, `---\nname: ${name}\ndescription: Do ${name}\n---\nSteps\n`, "utf8");
    return file;
  };

  it("archives Synthra's skill and the user's own, unpins, and restores", async () => {
    const paths = await setup();
    process.env.SYN_SKILL_APPROVAL = "0";
    await createSkill(paths, { scope: "global", ...skill });
    delete process.env.SYN_SKILL_APPROVAL;
    const learned = join(paths.globalSkillsDir, skill.name, "SKILL.md");
    await setPin(paths.skillState, learned, true);
    const own = await userSkill(paths, "deploy", "project");
    const c = ctxOf(paths);

    const a = await handleDelete({ path: learned }, c);
    expect(a).toMatchObject({ ok: true });
    expect(await exists(learned)).toBe(false);
    expect([...(await readPins(paths.skillState))]).toEqual([]);

    const b = await handleDelete({ path: own }, c);
    expect(b).toMatchObject({ ok: true });
    expect((b as { archivePath: string }).archivePath).toBe(
      join(paths.contextDir, "skills-archive", "deploy"),
    );
    const events = (await readLedger(paths.skillState)).filter((e) => e.action === "archive");
    expect(events.map((e) => [e.name, e.actor])).toEqual([
      [skill.name, "user"],
      ["deploy", "user"],
    ]);

    expect(
      await restoreSkill(paths.skillState, (b as { archivePath: string }).archivePath),
    ).toMatchObject({
      ok: true,
    });
    expect(await exists(own)).toBe(true);
  });

  it("refuses an installed skill, an unknown path, and a missing path", async () => {
    const paths = await setup();
    const installed = await userSkill(paths, "ask-sonner", "global");
    await mkdir(join(paths.globalSkillsDir, "..", "..", ".agents"), { recursive: true });
    await writeFile(
      skillLockPath(paths, "global"),
      JSON.stringify({ skills: { "ask-sonner": { source: "emilkowalski/skills" } } }),
      "utf8",
    );
    const c = ctxOf(paths);
    expect(await handleDelete({ path: installed }, c)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/installed from emilkowalski\/skills/),
    });
    expect(await exists(installed)).toBe(true);
    expect(
      await handleDelete({ path: join(paths.projectRoot, "nope", "SKILL.md") }, c),
    ).toMatchObject({
      ok: false,
    });
    expect(await handleDelete({}, c)).toMatchObject({ ok: false });
  });

  // A link into a shared skills repo: only the link moves, the repo is untouched.
  it("moves a linked skill's link, never the folder it points at", async () => {
    const paths = await setup();
    const repo = await mkdtemp(join(tmpdir(), "syn-shared-skills-"));
    const target = join(repo, "hubspot");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "SKILL.md"),
      "---\nname: hubspot\ndescription: x\n---\nSteps\n",
      "utf8",
    );
    await mkdir(paths.globalSkillsDir, { recursive: true });
    try {
      await symlink(
        target,
        join(paths.globalSkillsDir, "hubspot"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return; // no links on this machine
    }
    const r = await handleDelete(
      { path: join(paths.globalSkillsDir, "hubspot", "SKILL.md") },
      ctxOf(paths),
    );
    expect(r).toMatchObject({ ok: true });
    expect(await exists(join(target, "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.globalSkillsDir, "hubspot"))).toBe(false);
  });
});
