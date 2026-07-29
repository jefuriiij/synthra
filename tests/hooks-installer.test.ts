// installHooks writes into .claude/settings.local.json — a file the user owns,
// that Claude Code also writes, and that holds every permission they've granted.
// These tests exist because it used to rebuild that file from an empty object
// whenever it couldn't parse it.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installHooks } from "../src/hooks/installer.js";
import { resolvePaths } from "../src/shared/paths.js";

async function project(): Promise<ReturnType<typeof resolvePaths>> {
  const root = await mkdtemp(join(tmpdir(), "syn-installer-"));
  return resolvePaths(root);
}

/** A settings file shaped like a real one: permissions plus a foreign hook. */
const REAL_SETTINGS = {
  permissions: {
    allow: ["Bash(npm run test:*)", "Bash(git status)", "Read(//c/Users/Jeff/**)"],
    deny: ["Bash(rm -rf *)"],
  },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "echo 'someone elses hook'" }] }],
  },
};

describe("installHooks", () => {
  it("creates the file on a first run", async () => {
    const paths = await project();
    const r = await installHooks(paths);
    expect(r.settingsUpdated).toBe(true);
    expect(r.scriptsWritten.length).toBeGreaterThan(0);
    const cfg = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    expect(Object.keys(cfg.hooks).length).toBeGreaterThan(0);
  });

  it("keeps the user's permissions and foreign hooks when merging", async () => {
    const paths = await project();
    await mkdir(join(paths.claudeDir), { recursive: true });
    await writeFile(paths.claudeSettings, JSON.stringify(REAL_SETTINGS, null, 2), "utf8");

    await installHooks(paths);
    const cfg = JSON.parse(await readFile(paths.claudeSettings, "utf8"));

    expect(cfg.permissions).toEqual(REAL_SETTINGS.permissions);
    const stopCommands = cfg.hooks.Stop.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(stopCommands.some((c: string) => c.includes("someone elses hook"))).toBe(true);
    expect(stopCommands.some((c: string) => c.includes("synthra-stop"))).toBe(true);
  });

  it("is idempotent — re-running doesn't duplicate our hook entries", async () => {
    const paths = await project();
    await installHooks(paths);
    await installHooks(paths);
    const cfg = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    const ours = cfg.hooks.Stop.flatMap((e: { hooks: { meta?: string }[] }) =>
      e.hooks.filter((h) => h.meta === "synthra-hook=true"),
    );
    expect(ours).toHaveLength(1);
  });

  // THE regression. Before this, an unparseable settings file was read as {},
  // merged, and written back containing only Synthra's hooks — annihilating the
  // user's permissions and any hook another tool had installed.
  it("refuses to touch an unreadable settings file", async () => {
    const paths = await project();
    await mkdir(join(paths.claudeDir), { recursive: true });
    const damaged = `${JSON.stringify(REAL_SETTINGS, null, 2)}\n{{{ truncated garbage`;
    await writeFile(paths.claudeSettings, damaged, "utf8");

    const r = await installHooks(paths);

    expect(r.settingsUpdated).toBe(false);
    expect(r.settingsUnreadable).toBeTruthy();
    // A copy was set aside so the user can recover their permissions...
    const copies = (await readdir(paths.claudeDir)).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
    expect(await readFile(join(paths.claudeDir, copies[0] as string), "utf8")).toBe(damaged);
    // ...and no rebuilt-from-nothing file was written in its place.
    const rebuilt = (await readdir(paths.claudeDir)).includes("settings.local.json");
    expect(rebuilt).toBe(false);
    // The hook scripts themselves still landed — only registration was skipped.
    expect(r.scriptsWritten.length).toBeGreaterThan(0);
  });

  it("still writes the hook scripts even when settings can't be registered", async () => {
    const paths = await project();
    await mkdir(join(paths.claudeDir), { recursive: true });
    await writeFile(paths.claudeSettings, "not json", "utf8");
    const r = await installHooks(paths);
    for (const script of r.scriptsWritten) {
      expect((await readFile(script, "utf8")).length).toBeGreaterThan(0);
    }
  });

  it("leaves no temp files behind", async () => {
    const paths = await project();
    await installHooks(paths);
    expect((await readdir(paths.claudeDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
