// v0.49: the fixes from the November 2026 audit that have no better home.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripGitignoreEntries } from "../src/cli/remove-command.js";
import type { FileNode, GraphSchema } from "../src/graph/types.js";
import { recordUse, setPin, skillAges } from "../src/learn/curator.js";
import { createSkill, findSkill } from "../src/learn/skills.js";
import { startServer } from "../src/server/http.js";
import { graphPathOf, resolveFileTarget } from "../src/server/mcp.js";
import { looksLikeNonSymbolQuery } from "../src/server/routes/query-heuristics.js";
import { resolvePaths } from "../src/shared/paths.js";

const file = (path: string): FileNode =>
  ({ id: `file:${path}`, kind: "file", path, file_hash: "h" }) as unknown as FileNode;

describe("map tools take Windows paths", () => {
  const root = process.platform === "win32" ? "C:\\work\\shop" : "/work/shop";
  const graph = {
    root,
    nodes: [file("src/auth.ts"), file("lib/auth.ts")],
  } as unknown as GraphSchema;

  it("turns backslashes, ./ and full paths into the graph's own form", () => {
    expect(graphPathOf(root, "src\\auth.ts")).toBe("src/auth.ts");
    expect(graphPathOf(root, "./src/auth.ts")).toBe("src/auth.ts");
    expect(graphPathOf(root, join(root, "src", "auth.ts"))).toBe("src/auth.ts");
    expect(graphPathOf(root, "src/auth.ts")).toBe("src/auth.ts");
  });

  it("finds the file for each spelling", () => {
    for (const p of ["src\\auth.ts", "./src/auth.ts", join(root, "src", "auth.ts")]) {
      const r = resolveFileTarget(graph, p);
      expect("node" in r && r.node.path).toBe("src/auth.ts");
    }
  });

  it.runIf(process.platform === "win32")("ignores the drive letter's case", () => {
    const r = resolveFileTarget(graph, "c:\\work\\shop\\lib\\auth.ts");
    expect("node" in r && r.node.path).toBe("lib/auth.ts");
  });
});

describe("the Grep gate can't freeze the server", () => {
  it("checks a long hyphen pattern at once", () => {
    const t = Date.now();
    expect(looksLikeNonSymbolQuery(`${"a-".repeat(50_000)} x`)).toBe(false);
    // Before v0.49 4,000 characters took 4.6 s, and the time grew as n^3.
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("still spots a hyphenated attribute", () => {
    expect(looksLikeNonSymbolQuery("data-tour=")).toBe(true);
    expect(looksLikeNonSymbolQuery('aria-label = "x"')).toBe(true);
    expect(looksLikeNonSymbolQuery("foo=")).toBe(false);
    expect(looksLikeNonSymbolQuery("x-y z=")).toBe(false);
  });
});

describe("syn remove keeps the user's .gitignore", () => {
  it("keeps a .mcp.json line the user had before Synthra", () => {
    const body = [
      "node_modules/",
      ".mcp.json",
      "# added by synthra (heavy generated state)",
      ".synthra-graph/",
    ].join("\n");
    const out = stripGitignoreEntries(body);
    expect(out.split("\n")).toEqual(["node_modules/", ".mcp.json"]);
  });

  it("removes the .mcp.json line Synthra added, under its comment", () => {
    const body = ["dist/", "# added by synthra (MCP registration)", ".mcp.json"].join("\n");
    expect(stripGitignoreEntries(body)).toBe("dist/");
  });

  it("keeps CRLF line endings", () => {
    const body = "dist/\r\n# added by synthra (state)\r\n.synthra-graph/\r\n*.log\r\n";
    expect(stripGitignoreEntries(body)).toBe("dist/\r\n*.log\r\n");
  });
});

// VS Code opens a folder as "c:\...", a terminal as "C:\...": the Curator kept
// favorites and uses by the exact string and archived a skill in use.
describe.runIf(process.platform === "win32")("the Curator ignores the drive letter's case", () => {
  it("sees a use and a favorite saved under the other spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-curator-case-"));
    const project = join(root, "aster");
    await mkdir(project);
    const paths = {
      ...resolvePaths(project),
      globalSkillsDir: join(root, "home", ".claude", "skills"),
      skillState: join(root, "home", ".synthra", "skills"),
    };
    process.env.SYN_SKILL_APPROVAL = "0";
    try {
      await createSkill(paths, {
        scope: "project",
        name: "alpha",
        description: "Use when alpha.",
        body: "1. Do it.",
      });
    } finally {
      delete process.env.SYN_SKILL_APPROVAL;
    }
    const path = (await findSkill(paths, "alpha", "project"))!.path;
    const other =
      path[0] === path[0]!.toUpperCase()
        ? path[0]!.toLowerCase() + path.slice(1)
        : path[0]!.toUpperCase() + path.slice(1);
    const later = Date.now() + 40 * 24 * 60 * 60 * 1000;
    await recordUse(paths.skillState, other, later - 2 * 24 * 60 * 60 * 1000);
    await setPin(paths.skillState, other, true);
    const [age] = await skillAges(paths, later);
    expect(age?.daysUnused).toBe(2);
    expect(age?.pinned).toBe(true);
  });
});

describe("the server's JSON says UTF-8", () => {
  // PowerShell 5.1 reads JSON with no charset as Latin-1: "café" reached
  // Claude as "cafÃ©".
  it("labels every JSON reply", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-charset-"));
    const handle = await startServer(resolvePaths(dir), { version: "test" });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(res.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    } finally {
      await handle.stop();
    }
  });
});
