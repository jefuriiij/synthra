// v0.33 — the project's knowledge for every AI, not only Claude: Synthra's
// block in AGENTS.md (read by Codex, Cursor, Copilot, Gemini CLI, …), the
// empty MEMORY.md `syn .` creates, the `memory` MCP tool, and `syn remove`.

import { describe, it, expect } from "vitest";
import { lstat, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import { bootstrap } from "../src/cli/bootstrap.js";
import { removeSynthra } from "../src/cli/remove-command.js";
import {
  AGENTS_BEGIN,
  AGENTS_TITLE,
  agentsBlock,
  patchAgentsMd,
  rulesSkeleton,
  stripAgentsBlock,
} from "../src/hooks/agents-md.js";
import { claudeStub, legacyOnboardingSkeleton, patchClaudeMd } from "../src/hooks/claude-md.js";
import type { ServerContext } from "../src/server/context.js";
import { handleMcpRequest } from "../src/server/mcp.js";
import { resolvePaths } from "../src/shared/paths.js";

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

describe("patchAgentsMd", () => {
  it("creates AGENTS.md with a title and Synthra's block", async () => {
    const path = join(await tmp("syn-agents-"), "AGENTS.md");
    expect(await patchAgentsMd(path)).toEqual({ created: true, updated: false, skipped: false });
    const text = await readFile(path, "utf8");
    expect(text.startsWith(`${AGENTS_TITLE}\n\n${AGENTS_BEGIN}`)).toBe(true);
    for (const s of [
      ".synthra/MEMORY.md",
      ".synthra/CONTEXT.md",
      "~/.synthra/USER.md",
      "SKILL.md",
    ]) {
      expect(text).toContain(s);
    }
  });

  it("states the configured limits", () => {
    const block = agentsBlock({ memoryChars: 4200, userChars: 1500 } as never);
    expect(block).toContain("MEMORY.md 4,200 characters");
    expect(block).toContain("USER.md 1,500");
  });

  it("is idempotent: the second run writes nothing", async () => {
    const path = join(await tmp("syn-agents-"), "AGENTS.md");
    await patchAgentsMd(path);
    const once = await readFile(path, "utf8");
    expect((await patchAgentsMd(path)).skipped).toBe(true);
    expect(await readFile(path, "utf8")).toBe(once);
  });

  it("keeps the user's content and replaces an older block", async () => {
    const path = join(await tmp("syn-agents-"), "AGENTS.md");
    await writeFile(
      path,
      "# Our rules\n\nUse tabs.\n\n<!-- synthra-agents v0 BEGIN -->\nold\n<!-- synthra-agents v0 END -->\n",
      "utf8",
    );
    await patchAgentsMd(path);
    const text = await readFile(path, "utf8");
    expect(text.startsWith("# Our rules\n\nUse tabs.\n\n")).toBe(true);
    expect(text).not.toContain("v0 BEGIN");
    expect((text.match(/synthra-agents v\d+ BEGIN/g) ?? []).length).toBe(1);
    expect(stripAgentsBlock(text).trim()).toBe("# Our rules\n\nUse tabs.");
  });

  // Repos often link CLAUDE.md -> AGENTS.md. Writing must not break the link.
  it("writes through a symlink instead of replacing it", async () => {
    const dir = await tmp("syn-agents-");
    await writeFile(join(dir, "AGENTS.md"), "# Shared rules\n", "utf8");
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"));
    await patchClaudeMd(join(dir, "CLAUDE.md"));
    await patchAgentsMd(join(dir, "AGENTS.md"));
    expect((await lstat(join(dir, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dir, "CLAUDE.md"))).toBe("AGENTS.md");
    const text = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(text).toContain("synthra-policy v");
    expect(text).toContain("synthra-agents v");
    // One file: an @AGENTS.md import in it would import itself.
    expect(text).not.toContain("@AGENTS.md");
  });
});

describe("patchAgentsMd with the rules starter", () => {
  it("starts a new file with the starter, then Synthra's block, and stays put", async () => {
    const path = join(await tmp("syn-agents-"), "AGENTS.md");
    const r = await patchAgentsMd(path, { projectName: "shop", scaffold: true });
    expect(r.created).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text.startsWith(rulesSkeleton("shop").trimEnd())).toBe(true);
    expect(text.indexOf("## Gotchas")).toBeLessThan(text.indexOf(AGENTS_BEGIN));
    expect(text).toContain(".synthra/MEMORY.md");
    expect((await patchAgentsMd(path, { projectName: "shop", scaffold: true })).skipped).toBe(true);
  });

  // 0.33 and 0.34 wrote only a title and the block.
  it("adds the starter to a file that holds only Synthra's title and block", async () => {
    const path = join(await tmp("syn-agents-"), "AGENTS.md");
    await patchAgentsMd(path);
    expect((await patchAgentsMd(path, { projectName: "shop", scaffold: true })).updated).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text.startsWith("# shop\n")).toBe(true);
    expect(text).not.toContain(AGENTS_TITLE);
  });

  it("never adds the starter to a file with the user's own rules", async () => {
    const path = join(await tmp("syn-agents-"), "AGENTS.md");
    await writeFile(path, "# Our rules\n\nUse tabs.\n", "utf8");
    await patchAgentsMd(path, { projectName: "shop", scaffold: true });
    const text = await readFile(path, "utf8");
    expect(text.startsWith("# Our rules\n\nUse tabs.\n\n")).toBe(true);
    expect(text).not.toContain("## Build & test");
  });
});

describe("syn . puts the rules in AGENTS.md", () => {
  it("a new project: rules starter in AGENTS.md, CLAUDE.md imports it", async () => {
    const root = await tmp("syn-rules-new-");
    const paths = resolvePaths(root);
    const r = await bootstrap(paths);
    expect(r).toMatchObject({
      claudeMdCreated: true,
      agentsMdCreated: true,
      agentsMdScaffolded: true,
    });

    const agents = await readFile(paths.agentsMd, "utf8");
    expect(agents).toContain("## Build & test");
    const claude = await readFile(paths.claudeMd, "utf8");
    expect(claude).toContain("\n@AGENTS.md\n");
    expect(claude).not.toContain("## Build & test");

    const again = await bootstrap(paths);
    expect(again).toMatchObject({ agentsMdUpdated: false, agentsMdScaffolded: false });
  });

  // A 0.34 project: the old starter in CLAUDE.md, a title-only AGENTS.md.
  it("moves an untouched old starter from CLAUDE.md to AGENTS.md", async () => {
    const root = await tmp("syn-rules-old-");
    const paths = resolvePaths(root);
    const name = basename(root);
    await writeFile(paths.claudeMd, `${legacyOnboardingSkeleton(name)}\n`, "utf8");
    await patchAgentsMd(paths.agentsMd);

    const r = await bootstrap(paths);
    expect(r.agentsMdScaffolded).toBe(true);
    expect(await readFile(paths.agentsMd, "utf8")).toContain("## Key decisions");
    const claude = await readFile(paths.claudeMd, "utf8");
    expect(claude.startsWith(claudeStub(name).trimEnd())).toBe(true);
    expect(claude).not.toContain("TODO");
  });

  it("leaves rules the user keeps in CLAUDE.md where they are", async () => {
    const root = await tmp("syn-rules-own-");
    const paths = resolvePaths(root);
    await writeFile(paths.claudeMd, "# Our rules\n\nRun `make dev`.\n", "utf8");

    const r = await bootstrap(paths);
    expect(r.agentsMdScaffolded).toBe(false);
    expect(await readFile(paths.agentsMd, "utf8")).not.toContain("## Build & test");
    const claude = await readFile(paths.claudeMd, "utf8");
    expect(claude.startsWith("# Our rules\n\nRun `make dev`.\n\n")).toBe(true);
    expect(claude).toContain("\n@AGENTS.md\n");
  });

  it("syn remove deletes both files when they hold only Synthra's text", async () => {
    const root = await tmp("syn-rules-rm-");
    await bootstrap(resolvePaths(root));
    const r = await removeSynthra(root);
    expect(await exists(join(root, "AGENTS.md"))).toBe(false);
    expect(await exists(join(root, "CLAUDE.md"))).toBe(false);
    expect(r.removed).toContain("CLAUDE.md (was synthra-generated)");
  });
});

describe("syn . and syn remove", () => {
  it("bootstrap writes AGENTS.md and an empty MEMORY.md", async () => {
    const root = await tmp("syn-agents-boot-");
    const paths = resolvePaths(root);
    const r = await bootstrap(paths);
    expect(r).toMatchObject({ agentsMdCreated: true, memoryMdCreated: true });
    expect(await readFile(paths.memoryMd, "utf8")).toMatch(/^# Project memory/);

    // A second run changes neither, and never overwrites the notes.
    await writeFile(paths.memoryMd, "# Project memory\n\n- Use pnpm\n", "utf8");
    const again = await bootstrap(paths);
    expect(again).toMatchObject({
      agentsMdCreated: false,
      agentsMdUpdated: false,
      memoryMdCreated: false,
    });
    expect(await readFile(paths.memoryMd, "utf8")).toBe("# Project memory\n\n- Use pnpm\n");
  });

  it("remove deletes an AGENTS.md Synthra made, and keeps one with your rules", async () => {
    const made = await tmp("syn-agents-rm-");
    await bootstrap(resolvePaths(made));
    await removeSynthra(made);
    expect(await exists(join(made, "AGENTS.md"))).toBe(false);

    const yours = await tmp("syn-agents-rm-");
    await writeFile(join(yours, "AGENTS.md"), "# Our rules\n\nUse tabs.\n", "utf8");
    await bootstrap(resolvePaths(yours));
    const r = await removeSynthra(yours);
    expect(await readFile(join(yours, "AGENTS.md"), "utf8")).toBe("# Our rules\n\nUse tabs.\n");
    expect(r.kept).toContain("AGENTS.md (synthra block stripped, your content kept)");
  });
});

describe("the memory MCP tool", () => {
  async function ctx(): Promise<ServerContext> {
    const dir = await tmp("syn-memtool-");
    const paths = resolvePaths(dir, join(dir, "home", ".synthra", "USER.md"));
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

  const call = async (c: ServerContext, args: Record<string, unknown>) => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory", arguments: args } },
      c,
    );
    const r = res.result as { content: { text: string }[]; isError: boolean };
    return { text: r.content[0]?.text ?? "", isError: r.isError };
  };

  it("is listed", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      await ctx(),
    );
    const names = (res.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain("memory");
  });

  it("adds to the project file and the user file, each in its own place", async () => {
    const c = await ctx();
    expect((await call(c, { target: "project", action: "add", content: "Use pnpm" })).isError).toBe(
      false,
    );
    expect(
      (await call(c, { target: "user", action: "add", content: "Prefers short answers" })).isError,
    ).toBe(false);
    expect(await readFile(c.paths.memoryMd, "utf8")).toMatch(/- Use pnpm\n$/);
    expect(await readFile(c.paths.userMemory, "utf8")).toMatch(/- Prefers short answers\n$/);

    const read = await call(c, { target: "project", action: "read" });
    expect(read.text).toContain(".synthra/MEMORY.md — 1 entry");
    expect(read.text).toContain("- Use pnpm");
  });

  it("consolidates in one call, and refuses past the limit with the file's entries", async () => {
    const c = await ctx();
    // 500 is the smallest limit the setting accepts.
    process.env.SYN_MEMORY_CHARS = "500";
    try {
      await call(c, { target: "project", action: "add", content: "Build: npm run build" });
      await call(c, { target: "project", action: "add", content: `Notes: ${"x".repeat(460)}` });
      const full = await call(c, {
        target: "project",
        action: "add",
        content: "Test: npm test -- --run",
      });
      expect(full.isError).toBe(true);
      expect(full.text).toContain("limit is 500");
      expect(full.text).toContain("- Build: npm run build");

      const merged = await call(c, {
        target: "project",
        operations: [
          { action: "remove", old_text: "Notes:" },
          { action: "replace", old_text: "Build", content: "Build/test: npm run build, npm test" },
        ],
      });
      expect(merged.isError).toBe(false);
      expect(merged.text).toContain("Build/test");
    } finally {
      delete process.env.SYN_MEMORY_CHARS;
    }
  });

  it("refuses a bad target and a secret", async () => {
    const c = await ctx();
    expect((await call(c, { target: "team", action: "add", content: "x" })).isError).toBe(true);
    const secret = await call(c, {
      target: "project",
      action: "add",
      content: "password: hunter2hunter2",
    });
    expect(secret.isError).toBe(true);
    expect(await exists(c.paths.memoryMd)).toBe(false);
  });
});
