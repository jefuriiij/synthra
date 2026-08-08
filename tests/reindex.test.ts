// Auto-reindex: rescanAndSwap keeps the in-memory graph fresh after edits, and
// createReindexer debounces + never overlaps rescans.

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import { readGraph, readSymbolIndex } from "../src/graph/store.js";
import { scanProject } from "../src/cli/scan-command.js";
import type { ServerContext } from "../src/server/context.js";
import { createReindexer, rescanAndSwap } from "../src/server/reindex.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function sigOf(ctx: ServerContext, name: string): string | undefined {
  const n = ctx.graph.nodes.find((x) => x.kind === "symbol" && x.name === name);
  return n && n.kind === "symbol" ? n.signature : undefined;
}

describe("rescanAndSwap", () => {
  it("swaps in a fresh graph reflecting edits, additions, and deletions", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-reindex-"));
    try {
      const file = join(root, "src", "a.ts");
      await write(file, "export function foo(): number {\n  return 1;\n}\n");
      await scanProject(root, { silent: true });

      const paths = resolvePaths(root);
      const [graph, symbolIndex] = await Promise.all([
        readGraph(paths.infoGraph),
        readSymbolIndex(paths.symbolIndex),
      ]);
      const ctx: ServerContext = {
        paths,
        graph,
        symbolIndex,
        activity: new ActivityStore(paths.activityLog),
      };

      expect(sigOf(ctx, "foo")).toContain("number");
      expect(ctx.symbolIndex.bar).toBeUndefined();

      // Edit: change foo's signature + add bar.
      await write(
        file,
        "export function foo(): string {\n  return 'x';\n}\nexport function bar(): void {}\n",
      );
      await rescanAndSwap(ctx, paths, "test");

      expect(sigOf(ctx, "foo")).toContain("string");
      expect(ctx.symbolIndex.bar).toBeDefined();

      // Delete bar.
      await write(file, "export function foo(): string {\n  return 'x';\n}\n");
      await rescanAndSwap(ctx, paths, "test");
      expect(ctx.symbolIndex.bar).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves CLAUDE.md byte-identical across reindexes (no rewrite → no watcher loop)", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-reindex-"));
    try {
      await write(join(root, "src", "a.ts"), "export const x = 1;\n");
      await scanProject(root, { silent: true }); // bootstrap writes CLAUDE.md once

      const paths = resolvePaths(root);
      const claudeMd = join(root, "CLAUDE.md");
      const before = await readFile(claudeMd, "utf8");
      const ctx: ServerContext = {
        paths,
        graph: await readGraph(paths.infoGraph),
        symbolIndex: await readSymbolIndex(paths.symbolIndex),
        activity: new ActivityStore(paths.activityLog),
      };

      // Two reindexes (skipBootstrap) must not touch CLAUDE.md at all — if they
      // did, the file-watcher would see its own write and rescan forever.
      await rescanAndSwap(ctx, paths, "t1");
      await rescanAndSwap(ctx, paths, "t2");

      expect(await readFile(claudeMd, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createReindexer", () => {
  const stubCtx = {} as unknown as ServerContext;
  const stubPaths = {} as unknown as SynthraPaths;

  it("coalesces a burst of schedule() calls into a single rescan", async () => {
    let calls = 0;
    const rx = createReindexer(stubCtx, stubPaths, {
      debounceMs: 10,
      rescan: async () => {
        calls += 1;
      },
    });
    rx.schedule();
    rx.schedule();
    rx.schedule();
    await sleep(40);
    expect(calls).toBe(1);
  });

  it("never overlaps: changes during an in-flight rescan trigger exactly one trailing run", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | null = null;
    const rescan = (): Promise<void> => {
      calls += 1;
      if (calls === 1) return new Promise<void>((res) => (releaseFirst = () => res()));
      return Promise.resolve();
    };
    const rx = createReindexer(stubCtx, stubPaths, { debounceMs: 5, rescan });

    rx.schedule();
    await sleep(20); // first rescan starts and is now in-flight (awaiting releaseFirst)
    expect(calls).toBe(1);

    rx.schedule();
    await sleep(20); // timer fires while first is in-flight → marked pending, no new call yet
    expect(calls).toBe(1);

    releaseFirst?.(); // first finishes → exactly one trailing run
    await sleep(20);
    expect(calls).toBe(2);
  });

  // v0.26: a branch switch used to call rescanAndSwap directly, bypassing the
  // guard above. Two scanProject runs then wrote the same graph files at once
  // and whichever finished last won — regardless of which saw the newer tree.
  it("runNow shares the non-overlap guard with schedule()", async () => {
    const labels: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const rescan = (_c: ServerContext, _p: SynthraPaths, label: string): Promise<void> => {
      labels.push(label);
      if (labels.length === 1) return new Promise<void>((res) => (releaseFirst = () => res()));
      return Promise.resolve();
    };
    const rx = createReindexer(stubCtx, stubPaths, { debounceMs: 5, rescan });

    rx.schedule();
    await sleep(20); // edit-scan is in flight
    expect(labels).toEqual(["edit"]);

    const branch = rx.runNow("branch feature/x");
    await sleep(20); // must NOT start a second scanner alongside the first
    expect(labels).toEqual(["edit"]);

    releaseFirst?.();
    await branch;
    expect(labels).toEqual(["edit", "branch feature/x"]);
  });

  it("runNow drops a queued debounce — a branch switch invalidates everything", async () => {
    const labels: string[] = [];
    const rx = createReindexer(stubCtx, stubPaths, {
      debounceMs: 30,
      rescan: async (_c, _p, label) => void labels.push(label),
    });

    rx.schedule(); // queued, not yet fired
    await rx.runNow("branch main");
    await sleep(60); // the pending edit-scan must not fire on top of it
    expect(labels).toEqual(["branch main"]);
  });
});
