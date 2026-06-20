// Bash exploration observer: the classifier must catch codebase hunts and
// ignore everything else, and observing must log (with avoidability) while
// NEVER blocking.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import { readGraph, readSymbolIndex } from "../src/graph/store.js";
import { scanProject } from "../src/cli/scan-command.js";
import type { ServerContext } from "../src/server/context.js";
import { classifyBashCommand, observeBash } from "../src/server/routes/bash-observe.js";
import { handleGate } from "../src/server/routes/gate.js";
import { resolvePaths } from "../src/shared/paths.js";

describe("classifyBashCommand", () => {
  it("flags ripgrep/grep codebase searches", () => {
    expect(classifyBashCommand("rg createSession src/")).toMatchObject({
      kind: "search",
      tool: "rg",
      query: "createSession",
    });
    expect(classifyBashCommand("rg foo")).toMatchObject({ kind: "search" }); // rg defaults recursive
    expect(classifyBashCommand("grep -r foo src/")).toMatchObject({ kind: "search" });
    expect(classifyBashCommand("grep foo file.ts")).toMatchObject({ kind: "search" });
  });

  it("ignores grep that filters another command's stdout", () => {
    expect(classifyBashCommand("grep foo")).toBeNull(); // no path → reads stdin
    expect(classifyBashCommand("npm test | grep error")).toBeNull();
  });

  it("flags cat/head of a source file, not config-less reads", () => {
    expect(classifyBashCommand("cat src/session.ts")).toMatchObject({
      kind: "read",
      query: "src/session.ts",
    });
    expect(classifyBashCommand("head -n 50 src/a.ts")).toMatchObject({ kind: "read" });
    expect(classifyBashCommand("cat .env")).toBeNull(); // no source extension
    expect(classifyBashCommand("cat")).toBeNull();
  });

  it("flags find/tree directory exploration", () => {
    expect(classifyBashCommand('find . -name "*.ts"')).toMatchObject({
      kind: "list",
      tool: "find",
      query: "*.ts",
    });
  });

  it("leaves real work alone", () => {
    expect(classifyBashCommand("npm test")).toBeNull();
    expect(classifyBashCommand("git status")).toBeNull();
    expect(classifyBashCommand("node bin/syn scan .")).toBeNull();
    expect(classifyBashCommand("ls -R")).toBeNull(); // ls is too common to gate
    expect(classifyBashCommand("")).toBeNull();
  });

  it("treats a redirect as a write, not exploration", () => {
    expect(classifyBashCommand("cat src/a.ts > out.txt")).toBeNull();
    expect(classifyBashCommand("rg foo src/ > hits.txt")).toBeNull();
  });

  it("is quote-aware: an operator inside the pattern doesn't split the command", () => {
    expect(classifyBashCommand('rg "foo|bar" src/')).toMatchObject({
      kind: "search",
      query: "foo|bar",
    });
    expect(classifyBashCommand("rg 'foo bar' src")).toMatchObject({ query: "foo bar" });
  });

  it("classifies the strongest segment of a chained command", () => {
    expect(classifyBashCommand("echo hi && rg foo src/")).toMatchObject({ kind: "search" });
    // cat of a real file wins over a stdin-grep
    expect(classifyBashCommand("cat src/a.ts | grep foo")).toMatchObject({ kind: "read" });
  });
});

describe("observeBash", () => {
  afterEach(() => {
    delete process.env.SYN_NO_BASH_OBSERVE;
  });

  async function fixture(): Promise<{ ctx: ServerContext; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "syn-bash-"));
    const file = join(root, "src", "a.ts");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      "export function greet(name: string): number {\n  return name.length;\n}\n",
    );
    await scanProject(root, { silent: true });
    const paths = resolvePaths(root);
    const ctx: ServerContext = {
      paths,
      graph: await readGraph(paths.infoGraph),
      symbolIndex: await readSymbolIndex(paths.symbolIndex),
      activity: new ActivityStore(paths.activityLog),
    };
    return { ctx, root };
  }

  async function readBashLog(ctx: ServerContext): Promise<Array<Record<string, unknown>>> {
    try {
      const text = await readFile(ctx.paths.bashLog, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  it("logs a search the graph can answer as avoidable", async () => {
    const { ctx, root } = await fixture();
    try {
      await observeBash({ command: "rg greet src/" }, ctx);
      const log = await readBashLog(ctx);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ kind: "search", tool: "rg", avoidable: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs a non-matching search as not avoidable, and a known-file cat as avoidable", async () => {
    const { ctx, root } = await fixture();
    try {
      await observeBash({ command: "rg zzzznotathing src/" }, ctx);
      await observeBash({ command: "cat src/a.ts" }, ctx);
      const log = await readBashLog(ctx);
      expect(log).toHaveLength(2);
      expect(log[0]).toMatchObject({ kind: "search", avoidable: false });
      expect(log[1]).toMatchObject({ kind: "read", avoidable: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not log non-exploration commands", async () => {
    const { ctx, root } = await fixture();
    try {
      await observeBash({ command: "npm test" }, ctx);
      expect(await readBashLog(ctx)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects SYN_NO_BASH_OBSERVE", async () => {
    const { ctx, root } = await fixture();
    try {
      process.env.SYN_NO_BASH_OBSERVE = "1";
      await observeBash({ command: "rg greet src/" }, ctx);
      expect(await readBashLog(ctx)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handleGate observes Bash but always allows (never blocks)", async () => {
    const { ctx, root } = await fixture();
    try {
      const res = await handleGate(
        { tool_name: "Bash", tool_input: { command: "rg greet src/" } },
        ctx,
      );
      expect(res.decision).toBe("allow");
      expect(await readBashLog(ctx)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
