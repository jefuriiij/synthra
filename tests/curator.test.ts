// The Curator (src/learn/curator.ts): a weekly tidy of the skills Synthra
// wrote — stale at 14 days unused, archived at 30 (a proposal while approval
// is on), never a pinned skill, never deleting, always restorable.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import {
  ARCHIVE_DAYS,
  curatorStatus,
  readUsage,
  recordUse,
  runCurator,
  setPin,
  skillAges,
} from "../src/learn/curator.js";
import {
  approveProposal,
  createSkill,
  findSkill,
  listArchived,
  listPending,
  readLedger,
  restoreSkill,
} from "../src/learn/skills.js";
import type { ServerContext } from "../src/server/context.js";
import { handleGate } from "../src/server/routes/gate.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

async function setup(): Promise<SynthraPaths> {
  const root = await mkdtemp(join(tmpdir(), "syn-curator-"));
  const project = join(root, "aster");
  await mkdir(project);
  return {
    ...resolvePaths(project),
    globalSkillsDir: join(root, "home", ".claude", "skills"),
    skillState: join(root, "home", ".synthra", "skills"),
  };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A live Synthra skill created at `at` (the ledger's create time). */
async function learned(
  paths: SynthraPaths,
  name: string,
  at: number,
  scope: "project" | "global" = "project",
) {
  process.env.SYN_SKILL_APPROVAL = "0";
  await createSkill(paths, { scope, name, description: `Use when ${name}.`, body: "1. Do it." });
  delete process.env.SYN_SKILL_APPROVAL;
  // Backdate the create in the ledger.
  const file = join(paths.skillState, "ledger.jsonl");
  const lines = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  for (const e of lines) if (e.name === name) e.ts = new Date(at).toISOString();
  await writeFile(file, lines.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return (await findSkill(paths, name, scope))!.path;
}

beforeEach(() => {
  delete process.env.SYN_SKILL_APPROVAL;
  delete process.env.SYN_CURATOR;
});
afterEach(() => {
  delete process.env.SYN_SKILL_APPROVAL;
  delete process.env.SYN_CURATOR;
});

describe("how long a skill has gone unused", () => {
  it("counts from the last use, or the last change", async () => {
    const paths = await setup();
    const a = await learned(paths, "alpha", T0);
    const b = await learned(paths, "beta", T0);
    await recordUse(paths.skillState, b, T0 + 10 * DAY);
    const ages = await skillAges(paths, T0 + 20 * DAY);
    expect(Object.fromEntries(ages.map((x) => [x.skill.path, x.daysUnused]))).toEqual({
      [a]: 20,
      [b]: 10,
    });
  });

  it("counts a change to a support file as activity for its skill", async () => {
    const paths = await setup();
    const a = await learned(paths, "alpha", T0);
    const ledger = join(paths.skillState, "ledger.jsonl");
    const e = {
      id: "x",
      ts: new Date(T0 + 15 * DAY).toISOString(),
      action: "create",
      actor: "agent",
      scope: "project",
      name: "alpha",
      path: join(a, "..", "references", "deep", "notes.md"),
      file: "references/deep/notes.md",
      project: paths.projectRoot,
    };
    await writeFile(ledger, `${await readFile(ledger, "utf8")}${JSON.stringify(e)}\n`, "utf8");
    const [age] = await skillAges(paths, T0 + 20 * DAY);
    expect(age?.daysUnused).toBe(5);
  });

  // A teammate's skill arrives through git with no history here.
  it("starts the clock when it first sees a skill it has no record of", async () => {
    const paths = await setup();
    const dir = join(paths.projectSkillsDir, "teammate");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: teammate\ndescription: Use when x.\nmetadata:\n  synthra: learned\n---\nSteps\n",
      "utf8",
    );
    const first = await skillAges(paths, T0);
    expect(first[0]?.daysUnused).toBe(0);
    expect((await readUsage(paths.skillState))[join(dir, "SKILL.md")]?.firstSeen).toBe(
      new Date(T0).toISOString(),
    );
    expect((await skillAges(paths, T0 + 3 * DAY))[0]?.daysUnused).toBe(3);
  });

  it("ignores skills Synthra didn't write", async () => {
    const paths = await setup();
    const dir = join(paths.projectSkillsDir, "mine");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: mine\ndescription: Mine\n---\nSteps\n",
      "utf8",
    );
    expect(await skillAges(paths, T0)).toEqual([]);
  });
});

describe("runCurator", () => {
  it("with approval on, proposes archiving a skill unused 30 days, and counts 14-day ones stale", async () => {
    const paths = await setup();
    const old = await learned(paths, "old", T0);
    await learned(paths, "middling", T0 + 30 * DAY); // 16 days unused: stale
    await learned(paths, "fresh", T0 + 40 * DAY);
    const run = await runCurator(paths, { now: T0 + 31 * DAY + 15 * DAY });
    expect(run).toMatchObject({ checked: 3, stale: 1, proposed: 1, archived: 0 });
    const [p] = await listPending(paths.skillState);
    expect(p).toMatchObject({ action: "archive", name: "old", reason: "Not used for 46 days." });
    expect(await exists(old)).toBe(true);

    // Approving moves it into the project's archive — inside .synthra/, in git.
    expect(await approveProposal(paths.skillState, p!.id)).toMatchObject({ ok: true });
    expect(await exists(old)).toBe(false);
    const [a] = await listArchived(paths.skillState);
    expect(a?.archivePath).toBe(join(paths.contextDir, "skills-archive", "old"));
    expect(await exists(join(a!.archivePath, "SKILL.md"))).toBe(true);
  });

  it("with approval off, archives at once, and restore puts it back", async () => {
    const paths = await setup();
    const g = await learned(paths, "globally", T0, "global");
    process.env.SYN_SKILL_APPROVAL = "0";
    const run = await runCurator(paths, { now: T0 + (ARCHIVE_DAYS + 1) * DAY });
    expect(run).toMatchObject({ archived: 1, proposed: 0 });
    const [a] = await listArchived(paths.skillState);
    expect(a?.archivePath).toBe(join(paths.skillState, "archive", "globally"));
    expect((await readLedger(paths.skillState)).at(-1)).toMatchObject({
      action: "archive",
      actor: "curator",
    });

    expect(await restoreSkill(paths.skillState, a!.archivePath)).toMatchObject({ ok: true });
    expect(await exists(g)).toBe(true);
    expect(await listArchived(paths.skillState)).toEqual([]);
    // Restoring counts as activity: the next run leaves it alone.
    const again = await runCurator(paths, { now: Date.now() + DAY, force: true });
    expect(again).toMatchObject({ archived: 0, proposed: 0 });
  });

  it("never touches a pinned skill", async () => {
    const paths = await setup();
    const p = await learned(paths, "keeper", T0);
    await setPin(paths.skillState, p, true);
    process.env.SYN_SKILL_APPROVAL = "0";
    expect(await runCurator(paths, { now: T0 + 90 * DAY })).toMatchObject({
      archived: 0,
      stale: 0,
    });
    expect(await exists(p)).toBe(true);
    expect((await curatorStatus(paths, T0 + 90 * DAY)).pinned.map((x) => x.name)).toEqual([
      "keeper",
    ]);
  });

  it("runs at most weekly, not at all when off — and 'Run now' ignores both", async () => {
    const paths = await setup();
    expect(await runCurator(paths, { now: T0 })).not.toBeNull();
    expect(await runCurator(paths, { now: T0 + 6 * DAY })).toBeNull();
    expect(await runCurator(paths, { now: T0 + 7 * DAY })).not.toBeNull();
    process.env.SYN_CURATOR = "0";
    expect(await runCurator(paths, { now: T0 + 30 * DAY })).toBeNull();
    expect(await runCurator(paths, { now: T0 + 30 * DAY, force: true })).not.toBeNull();
  });

  it("doesn't propose the same archive twice", async () => {
    const paths = await setup();
    await learned(paths, "old", T0);
    await runCurator(paths, { now: T0 + 40 * DAY });
    await runCurator(paths, { now: T0 + 50 * DAY });
    expect(
      (await listPending(paths.skillState)).filter((p) => p.action === "archive"),
    ).toHaveLength(1);
  });

  it("won't restore over a skill that took the old place", async () => {
    const paths = await setup();
    await learned(paths, "dup", T0);
    process.env.SYN_SKILL_APPROVAL = "0";
    await runCurator(paths, { now: T0 + 40 * DAY });
    await createSkill(paths, {
      scope: "project",
      name: "dup",
      description: "Use when dup.",
      body: "New.",
    });
    const [a] = await listArchived(paths.skillState);
    expect(await restoreSkill(paths.skillState, a!.archivePath)).toMatchObject({ ok: false });
  });
});

describe("usage, from the PreToolUse hook", () => {
  function ctxOf(paths: SynthraPaths): ServerContext {
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

  it("counts a Skill call for a Synthra skill, and always allows it", async () => {
    const paths = await setup();
    const p = await learned(paths, "release-checklist", T0);
    const c = ctxOf(paths);
    for (const input of [{ skill: "release-checklist" }, { command: "/release-checklist args" }]) {
      expect(await handleGate({ tool_name: "Skill", tool_input: input }, c)).toEqual({
        decision: "allow",
      });
    }
    expect((await readUsage(paths.skillState))[p]?.uses).toBe(2);
  });

  it("ignores plugin skills, unknown skills and junk input", async () => {
    const paths = await setup();
    const c = ctxOf(paths);
    for (const input of [{ skill: "design:polish" }, { skill: "nope" }, null, { skill: 42 }]) {
      expect(await handleGate({ tool_name: "Skill", tool_input: input as never }, c)).toEqual({
        decision: "allow",
      });
    }
    expect(await readUsage(paths.skillState)).toEqual({});
  });
});

describe("review fixes", () => {
  // Rejecting an archive means "keep it": it must not come back next week.
  it("treats a rejected archive as activity, so it isn't proposed again", async () => {
    const paths = await setup();
    await learned(paths, "keep-me", T0);
    await runCurator(paths, { now: T0 + 40 * DAY });
    const [p] = await listPending(paths.skillState);
    const { rejectProposal } = await import("../src/learn/skills.js");
    await rejectProposal(paths.skillState, p!.id);
    // A week on: only 7 days since the user said keep it.
    expect(await runCurator(paths, { now: T0 + 47 * DAY, force: true })).toMatchObject({
      proposed: 0,
    });
    // A new create rejected does NOT reset anything.
    expect((await readLedger(paths.skillState)).at(-1)).toMatchObject({
      action: "reject",
      rejected: "archive",
    });
  });

  it("keeps going when one skill can't be archived, and records the run", async () => {
    const paths = await setup();
    await learned(paths, "stuck", T0, "project");
    await learned(paths, "fine", T0, "global");
    // The project archive's parent is a FILE: that move can only fail.
    await mkdir(paths.contextDir, { recursive: true });
    await writeFile(join(paths.contextDir, "skills-archive"), "not a folder", "utf8");
    process.env.SYN_SKILL_APPROVAL = "0";
    const run = await runCurator(paths, { now: T0 + 40 * DAY });
    expect(run).toMatchObject({ archived: 1, failed: 1 });
    expect((await listArchived(paths.skillState)).map((a) => a.name)).toEqual(["fine"]);
    expect(await findSkill(paths, "stuck", "project")).not.toBeNull();
  });

  it("runs one pass at a time, so a double 'Run now' proposes once", async () => {
    const paths = await setup();
    await learned(paths, "old", T0);
    const [a, b] = await Promise.all([
      runCurator(paths, { now: T0 + 40 * DAY, force: true }),
      runCurator(paths, { now: T0 + 40 * DAY, force: true }),
    ]);
    expect(a).toBe(b);
    expect(await listPending(paths.skillState)).toHaveLength(1);
  });

  it("credits every Synthra skill with the used name, and a typed /name counts", async () => {
    const paths = await setup();
    const proj = await learned(paths, "deploy", T0, "project");
    const glob = await learned(paths, "deploy", T0, "global");
    const { recordUseByName } = await import("../src/learn/curator.js");
    await recordUseByName(paths, "/deploy staging", T0 + DAY);
    const u = await readUsage(paths.skillState);
    expect([u[proj]?.uses, u[glob]?.uses]).toEqual([1, 1]);
    await recordUseByName(paths, "plugin:deploy", T0 + DAY);
    await recordUseByName(paths, "/../../etc", T0 + DAY);
    expect((await readUsage(paths.skillState))[proj]?.uses).toBe(1);
  });

  it("moves a folder by copy when rename can't cross disks", async () => {
    const paths = await setup();
    const p = await learned(paths, "far", T0);
    const { moveDir } = await import("../src/learn/skills.js");
    const dst = join(paths.skillState, "archive", "far");
    await mkdir(join(dst, ".."), { recursive: true });
    const crossDisk = async () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    };
    await moveDir(join(p, ".."), dst, crossDisk);
    expect(await exists(join(dst, "SKILL.md"))).toBe(true);
    expect(await exists(p)).toBe(false);
    // Any other error — a locked file included — is not swallowed, and
    // nothing is copied or deleted.
    for (const code of ["ENOENT", "EPERM", "EBUSY"]) {
      const denied = async () => {
        throw Object.assign(new Error(code), { code });
      };
      await expect(moveDir(dst, join(paths.skillState, "x"), denied)).rejects.toThrow(code);
      expect(await exists(join(dst, "SKILL.md"))).toBe(true);
      expect(await exists(join(paths.skillState, "x"))).toBe(false);
    }
    // A copy that can't complete is removed, and the original stays.
    const empty = join(paths.skillState, "no-skill-md");
    await mkdir(empty, { recursive: true });
    await expect(moveDir(empty, join(paths.skillState, "y"), crossDisk)).rejects.toThrow();
    expect(await exists(empty)).toBe(true);
    expect(await exists(join(paths.skillState, "y"))).toBe(false);
  });
});
