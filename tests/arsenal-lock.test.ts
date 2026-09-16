// Source-repo grouping for skills installed with the `npx skills` CLI.
//
// That CLI COPIES a skill into .claude/skills — no symlink, no marker in the
// file — so its lock file (`.agents/.skill-lock.json`) is the only record of
// which repo it came from. computeArsenal reads it and stamps `pack` with the
// repo slug, so those skills group under their repo the way plugin skills group
// under their plugin. `pack_command` must stay UNSET: its presence marks an
// expanded command-pack member, rewrites the invoke string to `/<pack> <cmd>`,
// and hides the item from the Dispatcher. These are real standalone skills.

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { computeArsenal, type ArsenalItem } from "../src/dashboard/arsenal.js";
import { skillInvocation, detailSubtitle } from "../src/dashboard/ui/lib/arsenal-detail.js";
import { buildGroups } from "../src/dashboard/ui/lib/arsenal-groups.js";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} does things.\n---\n# ${name}\n`;

/** A fake home with two ordinary personal skills. Returns [home, project]. */
async function fixture(): Promise<{ home: string; project: string }> {
  const home = await mkdtemp(join(tmpdir(), "syn-lock-home-"));
  const project = await mkdtemp(join(tmpdir(), "syn-lock-proj-"));
  await write(join(home, ".claude", "skills", "ask-sonner", "SKILL.md"), skillMd("ask-sonner"));
  await write(join(home, ".claude", "skills", "my-own", "SKILL.md"), skillMd("my-own"));
  return { home, project };
}

const lockJson = (skills: Record<string, string>) =>
  JSON.stringify({
    version: 1,
    skills: Object.fromEntries(
      Object.entries(skills).map(([name, source]) => [
        name,
        {
          source,
          sourceType: "github",
          sourceUrl: `https://github.com/${source}`,
          skillPath: `skills/${name}`,
          skillFolderHash: "abc",
          installedAt: 1,
          updatedAt: 1,
        },
      ]),
    ),
    dismissed: [],
    lastSelectedAgents: ["claude-code"],
  });

const byName = (items: ArsenalItem[], name: string) => items.find((i) => i.name === name);

describe("skill lock → pack", () => {
  it("groups a lock-file skill under its repo and leaves others alone", async () => {
    const { home, project } = await fixture();
    await write(
      join(home, ".agents", ".skill-lock.json"),
      lockJson({ "ask-sonner": "emilkowalski/skills" }),
    );

    const data = await computeArsenal(project, home);
    const sonner = byName(data.skills, "ask-sonner");
    const own = byName(data.skills, "my-own");

    expect(sonner?.pack).toBe("emilkowalski/skills");
    expect(sonner?.pack_command).toBeUndefined();
    expect(own?.pack).toBeUndefined();
  });

  it("keeps the invoke string as /<name> — it is a standalone skill, not a pack member", async () => {
    const { home, project } = await fixture();
    await write(
      join(home, ".agents", ".skill-lock.json"),
      lockJson({ "ask-sonner": "emilkowalski/skills" }),
    );
    const data = await computeArsenal(project, home);
    const sonner = byName(data.skills, "ask-sonner") as ArsenalItem;
    expect(skillInvocation(sonner, "skills")).toBe("/ask-sonner");
  });

  it("lets the hard-coded PACKS table win over the lock", async () => {
    const { home, project } = await fixture();
    await write(join(home, ".claude", "skills", "impeccable", "SKILL.md"), skillMd("impeccable"));
    await write(
      join(home, ".agents", ".skill-lock.json"),
      lockJson({ impeccable: "pbakaus/impeccable", "ask-sonner": "emilkowalski/skills" }),
    );

    const data = await computeArsenal(project, home);
    expect(byName(data.skills, "impeccable")?.pack).toBe("impeccable");
    expect(byName(data.skills, "ask-sonner")?.pack).toBe("emilkowalski/skills");
  });

  it("is a no-op when the lock file is missing", async () => {
    const { home, project } = await fixture();
    const data = await computeArsenal(project, home);
    expect(data.skills.every((s) => s.pack === undefined)).toBe(true);
  });

  it("is a no-op when the lock file is malformed", async () => {
    const { home, project } = await fixture();
    await write(join(home, ".agents", ".skill-lock.json"), "{ not json");
    const data = await computeArsenal(project, home);
    expect(data.skills.every((s) => s.pack === undefined)).toBe(true);
  });

  it("scopes the lookup: a project lock never labels a personal skill", async () => {
    const { home, project } = await fixture();
    // Same name in both scopes; only the project lock names it.
    await write(join(project, ".claude", "skills", "ask-sonner", "SKILL.md"), skillMd("ask-sonner"));
    await write(
      join(project, ".agents", ".skill-lock.json"),
      lockJson({ "ask-sonner": "emilkowalski/skills" }),
    );

    const data = await computeArsenal(project, home);
    const personal = data.skills.find((s) => s.name === "ask-sonner" && s.scope === "personal");
    const proj = data.skills.find((s) => s.name === "ask-sonner" && s.scope === "project");
    expect(proj?.pack).toBe("emilkowalski/skills");
    expect(personal?.pack).toBeUndefined();
  });
});

describe("repo-slug labels", () => {
  const sonner: ArsenalItem = {
    name: "ask-sonner",
    description: "",
    scope: "personal",
    pack: "emilkowalski/skills",
  };

  it("shows the slug as-is in the group panel instead of title-casing it", () => {
    const groups = buildGroups([sonner], {});
    const row = groups.find((g) => g.key === "pack:emilkowalski/skills");
    expect(row?.label).toBe("emilkowalski/skills");
    expect(row?.scope).toBe("pack"); // sorts with packs: after personal, before plugins
  });

  it("reads as a place in the detail subtitle", () => {
    expect(detailSubtitle(sonner)).toBe("installed from emilkowalski/skills");
  });
});
