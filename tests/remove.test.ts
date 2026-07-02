// `syn remove` — the uninstall mirror of `syn .`. The invariant under test:
// everything Synthra created is removed, and everything the USER wrote in
// shared files (.gitignore, CLAUDE.md, settings.local.json, .mcp.json) survives.

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { bootstrap } from "../src/cli/bootstrap.js";
import { removeSynthra, stripGitignoreEntries } from "../src/cli/remove-command.js";
import { patchClaudeMd } from "../src/hooks/claude-md.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";
import { forgetProject } from "../src/shared/project-registry.js";

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "syn-remove-"));
}

// Seed what installHooks writes, by hand — importing installer.ts here would
// drag its raw .ps1/.sh script imports into vitest, which can't load them.
async function seedHooks(paths: SynthraPaths): Promise<void> {
  await mkdir(paths.claudeHooksDir, { recursive: true });
  const settings = { hooks: {} as Record<string, unknown[]> };
  for (const base of ["synthra-prime", "synthra-pre-tool-use", "synthra-pre-compact"]) {
    const script = join(paths.claudeHooksDir, `${base}.ps1`);
    await writeFile(script, "# synthra hook\n", "utf8");
    settings.hooks[base] = [
      { hooks: [{ type: "command", command: script, meta: "synthra-hook=true" }] },
    ];
  }
  await writeFile(paths.claudeSettings, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("removeSynthra — full removal (the accidental `syn .` case)", () => {
  it("removes every bootstrap artifact from a pristine project", async () => {
    const root = await tmpProject();
    const paths = resolvePaths(root);
    await bootstrap(paths); // .synthra-graph/ + .synthra/ + .gitignore + CLAUDE.md
    await seedHooks(paths); // hook scripts + settings.local.json (as installHooks writes)
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { synthra: { type: "http", url: "http://x" } } }),
      "utf8",
    );

    const result = await removeSynthra(root);

    expect(await exists(paths.graphDir)).toBe(false);
    expect(await exists(paths.contextDir)).toBe(false);
    expect(await exists(paths.gitignore)).toBe(false); // was synthra-only
    expect(await exists(paths.claudeMd)).toBe(false); // pristine skeleton → deleted
    expect(await exists(paths.claudeHooksDir)).toBe(false); // only synthra scripts inside
    expect(await exists(paths.claudeSettings)).toBe(false); // synthra-only hooks
    expect(await exists(join(root, ".mcp.json"))).toBe(false); // synthra-only server
    expect(result.removed.length).toBeGreaterThanOrEqual(6);
    expect(result.kept).toEqual([]);
  });

  it("is a safe no-op on a project without Synthra", async () => {
    const root = await tmpProject();
    await writeFile(join(root, "app.ts"), "export {};\n", "utf8");
    const result = await removeSynthra(root);
    expect(result.removed).toEqual([]);
    expect(await exists(join(root, "app.ts"))).toBe(true);
  });
});

describe("removeSynthra — user content survives", () => {
  it("keeps user .gitignore lines, strips only synthra entries + comments", async () => {
    const root = await tmpProject();
    const paths = resolvePaths(root);
    await writeFile(paths.gitignore, "node_modules/\n*.log\n", "utf8");
    await bootstrap(paths); // appends the synthra block

    await removeSynthra(root);

    const after = await readFile(paths.gitignore, "utf8");
    expect(after).toContain("node_modules/");
    expect(after).toContain("*.log");
    expect(after).not.toContain("synthra");
    expect(after).not.toContain(".mcp.json");
  });

  it("keeps a user-authored CLAUDE.md, stripping only the policy block", async () => {
    const root = await tmpProject();
    const paths = resolvePaths(root);
    await writeFile(paths.claudeMd, "# My project\n\nRun `make dev`.\n", "utf8");
    await patchClaudeMd(paths.claudeMd, basename(root)); // appends the block

    await removeSynthra(root);

    const after = await readFile(paths.claudeMd, "utf8");
    expect(after).toContain("# My project");
    expect(after).toContain("Run `make dev`.");
    expect(after).not.toContain("synthra-policy");
  });

  it("keeps user hooks in settings.local.json, strips synthra-marked ones", async () => {
    const root = await tmpProject();
    const paths = resolvePaths(root);
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(
      paths.claudeSettings,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "my-own-hook.sh" }] },
            { hooks: [{ type: "command", command: "x.ps1", meta: "synthra-hook=true" }] },
          ],
        },
        permissions: { allow: ["Bash(npm test)"] },
      }),
      "utf8",
    );

    await removeSynthra(root);

    const after = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    expect(JSON.stringify(after)).toContain("my-own-hook.sh");
    expect(JSON.stringify(after)).not.toContain("synthra-hook=true");
    expect(after.permissions.allow).toContain("Bash(npm test)"); // non-hook keys untouched
  });

  it("keeps .mcp.json when another server is registered", async () => {
    const root = await tmpProject();
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { synthra: { url: "http://x" }, other: { url: "http://y" } } }),
      "utf8",
    );

    await removeSynthra(root);

    const after = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.synthra).toBeUndefined();
  });
});

describe("stripGitignoreEntries", () => {
  it("removes entries and their synthra comments, keeps everything else", () => {
    const body = [
      "dist/",
      "# added by synthra (heavy generated state — gitignored by design)",
      ".synthra-graph/",
      "# my own comment",
      "*.tmp",
    ].join("\n");
    const out = stripGitignoreEntries(body);
    expect(out).toContain("dist/");
    expect(out).toContain("# my own comment");
    expect(out).toContain("*.tmp");
    expect(out).not.toContain(".synthra-graph/");
    expect(out).not.toContain("added by synthra");
  });
});

describe("forgetProject", () => {
  it("removes only the matching entry from a registry file", async () => {
    const dir = await tmpProject();
    const regPath = join(dir, "projects.json");
    await writeFile(
      regPath,
      JSON.stringify({
        schema_version: 1,
        projects: [
          { path: "C:\\proj\\a", name: "a", first_seen: "x", last_seen: "x" },
          { path: "C:\\proj\\b", name: "b", first_seen: "x", last_seen: "x" },
        ],
      }),
      "utf8",
    );

    expect(await forgetProject("C:\\proj\\a", regPath)).toBe(true);
    const after = JSON.parse(await readFile(regPath, "utf8"));
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0].name).toBe("b");

    expect(await forgetProject("C:\\proj\\zzz", regPath)).toBe(false); // no match
  });
});
