// Backup and restore (src/learn/backup.ts): what lives on one machine only,
// carried to a new one, merged and never overwritten.

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readPins, readUsage, setPin } from "../src/learn/curator.js";
import { checkBackup, createBackup, remapPath, restoreBackup } from "../src/learn/backup.js";
import { listPending, readLedger, renderSkill, skillLockPath } from "../src/learn/skills.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

const before = process.env.SYN_SETTINGS;
afterEach(() => {
  if (before === undefined) delete process.env.SYN_SETTINGS;
  else process.env.SYN_SETTINGS = before;
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** One machine: a home folder with Synthra's state, and a project. */
async function machine(name: string): Promise<{ home: string; paths: SynthraPaths }> {
  const home = await mkdtemp(join(tmpdir(), `syn-backup-${name}-`));
  const project = join(home, "work", "shop");
  await mkdir(project, { recursive: true });
  process.env.SYN_SETTINGS = join(home, ".synthra", "settings.json");
  return {
    home,
    paths: {
      ...resolvePaths(project, join(home, ".synthra", "USER.md")),
      globalSkillsDir: join(home, ".claude", "skills"),
      skillState: join(home, ".synthra", "skills"),
    },
  };
}

const learned = (name: string, body: string) =>
  renderSkill({ name, description: `Use when ${name}.`, body });
const yours = (body: string) => `---\nname: deploy\ndescription: Ship it\n---\n\n${body}\n`;

describe("backup, then restore on a new machine", () => {
  it("adds what is missing, holds differences for the OK, and merges the rest", async () => {
    // Machine A.
    const a = await machine("a");
    const ga = a.paths.globalSkillsDir;
    await put(join(ga, "css-motion", "SKILL.md"), learned("css-motion", "1. Ease."));
    await put(join(ga, "css-motion", "references", "rail.md"), "# Rail");
    await put(join(ga, "deploy", "SKILL.md"), yours("Build, then ship."));
    await put(join(ga, "ask-sonner", "SKILL.md"), yours("toasts").replace("deploy", "ask-sonner"));
    await put(
      skillLockPath(a.paths, "global"),
      JSON.stringify({
        skills: {
          "ask-sonner": { source: "emilkowalski/skills" },
          "react:components": { source: "google-labs-code/stitch-skills" },
        },
      }),
    );
    await put(a.paths.userMemory, "# About the user\n\n- Prefers short answers\n- Uses Windows\n");
    await put(process.env.SYN_SETTINGS!, JSON.stringify({ skillNudgeEvery: 30, curator: false }));
    const fav = join(ga, "css-motion", "SKILL.md");
    await setPin(a.paths.skillState, fav, true);
    await put(
      join(a.paths.skillState, "usage.json"),
      JSON.stringify({ [fav]: { uses: 5, lastUsed: "2026-10-01T00:00:00.000Z" } }),
    );
    await put(
      join(a.paths.skillState, "ledger.jsonl"),
      `${JSON.stringify({ id: "e1", ts: "2026-09-01T00:00:00.000Z", action: "create", actor: "agent", scope: "global", name: "css-motion", path: fav, project: "/x" })}\n`,
    );
    await put(join(a.paths.skillState, "blobs", `${"a".repeat(40)}.md`), "old text");
    await put(
      join(a.paths.skillState, "archive", "old-skill", "SKILL.md"),
      learned("old-skill", "x"),
    );

    const backup = await createBackup(a.paths, { version: "test", home: a.home });
    expect(backup.skills.map((s) => [s.name, s.owner])).toEqual([
      ["css-motion", "synthra"],
      ["deploy", "user"],
    ]);
    expect(backup.installed).toEqual([
      { name: "ask-sonner", source: "emilkowalski/skills" },
      { name: "react:components", source: "google-labs-code/stitch-skills" },
    ]);
    // The file survives JSON, as it does on disk.
    const file = JSON.parse(JSON.stringify(backup));
    expect(checkBackup(file)).toBeNull();

    // Machine B: its own version of "deploy", one shared note, one setting.
    const b = await machine("b");
    const gb = b.paths.globalSkillsDir;
    await put(join(gb, "deploy", "SKILL.md"), yours("Ship."));
    await put(b.paths.userMemory, "# About the user\n\n- prefers   short answers\n");
    await put(process.env.SYN_SETTINGS!, JSON.stringify({ skillNudgeEvery: 10 }));

    const r = await restoreBackup(b.paths, file, { home: b.home });
    expect(r.added).toEqual(["css-motion"]);
    expect(await readFile(join(gb, "css-motion", "references", "rail.md"), "utf8")).toBe("# Rail");
    expect(r.waiting).toEqual(["deploy"]);
    expect(await readFile(join(gb, "deploy", "SKILL.md"), "utf8")).toBe(yours("Ship."));
    const [p] = await listPending(b.paths.skillState);
    expect(p).toMatchObject({ name: "deploy", owner: "user", before: yours("Ship.") });
    expect(r.reinstall).toEqual([
      {
        name: "ask-sonner",
        source: "emilkowalski/skills",
        command: "npx skills add emilkowalski/skills -g -s ask-sonner",
      },
      {
        name: "react:components",
        source: "google-labs-code/stitch-skills",
        command: "npx skills add google-labs-code/stitch-skills -g -s react:components",
      },
    ]);

    expect(r.userNotes).toBe(1);
    expect(await readFile(b.paths.userMemory, "utf8")).toBe(
      "# About the user\n\n- prefers   short answers\n- Uses Windows\n",
    );
    expect(r.settings).toEqual(["curator"]);
    expect(JSON.parse(await readFile(process.env.SYN_SETTINGS!, "utf8"))).toEqual({
      skillNudgeEvery: 10,
      curator: false,
    });

    const moved = join(gb, "css-motion", "SKILL.md");
    expect([...(await readPins(b.paths.skillState))]).toEqual([moved]);
    expect((await readUsage(b.paths.skillState))[moved]?.uses).toBe(5);
    expect((await readLedger(b.paths.skillState)).map((e) => [e.id, e.path])).toEqual([
      ["e1", moved],
    ]);
    expect(await exists(join(b.paths.skillState, "blobs", `${"a".repeat(40)}.md`))).toBe(true);
    expect(await exists(join(b.paths.skillState, "archive", "old-skill", "SKILL.md"))).toBe(true);

    // Twice is harmless: nothing is added again, and nothing waits twice.
    const again = await restoreBackup(b.paths, file, { home: b.home });
    expect(again.added).toEqual([]);
    expect(again.same).toEqual(["css-motion"]);
    expect(again.skipped).toEqual([
      { name: "deploy", why: "a change to it already waits for your OK" },
    ]);
    expect(again.userNotes).toBe(0);
    expect(again.history).toBe(0);
    expect(await listPending(b.paths.skillState)).toHaveLength(1);
  });

  it("never writes outside the skill folders, whatever the file says", async () => {
    const b = await machine("evil");
    const r = await restoreBackup(
      b.paths,
      {
        format: "synthra-backup",
        version: 1,
        created: "2026-10-04T00:00:00.000Z",
        synthra: "x",
        home: "/home/old",
        platform: "linux",
        skills: [
          { name: "../escape", owner: "user", files: [{ path: "SKILL.md", text: "x" }] },
          {
            name: "ok",
            owner: "user",
            files: [
              { path: "../../outside.md", text: "x" },
              { path: "SKILL.md", text: yours("fine") },
            ],
          },
        ],
        userMemory: null,
        settings: null,
        favorites: [],
        usage: {},
        ledger: [],
        blobs: { "../x": "y" },
        archive: [{ dir: "..", files: [{ path: "a.md", text: "x" }] }],
        installed: [{ name: "x", source: "a/b; rm -rf ~" }],
      },
      { home: b.home },
    );
    expect(r.added).toEqual(["ok"]);
    expect(r.skipped.map((s) => s.name)).toEqual(["../escape"]);
    expect(r.reinstall).toEqual([]);
    expect(await exists(join(b.paths.globalSkillsDir, "outside.md"))).toBe(false);
    expect(await exists(join(dirname(b.paths.globalSkillsDir), "outside.md"))).toBe(false);
  });

  it("refuses a file that isn't a backup, or one from a newer Synthra", () => {
    expect(checkBackup({ hello: 1 })).toMatch(/isn't a Synthra backup/);
    expect(checkBackup({ format: "synthra-backup", version: 99, skills: [], home: "/" })).toMatch(
      /newer Synthra/,
    );
  });
});

describe("remapPath", () => {
  it("moves paths under the old home to the new one, across systems", () => {
    expect(
      remapPath("/home/jeffreyj/.claude/skills/x/SKILL.md", "/home/jeffreyj", "/home/jeff"),
    ).toBe(join("/home/jeff", ".claude", "skills", "x", "SKILL.md"));
    expect(remapPath("C:\\Users\\Jeff\\.claude\\skills\\x", "c:\\users\\jeff", "/home/j")).toBe(
      join("/home/j", ".claude", "skills", "x"),
    );
    expect(remapPath("/opt/other/x", "/home/jeffreyj", "/home/jeff")).toBe("/opt/other/x");
  });
});
