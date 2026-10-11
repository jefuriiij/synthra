// v0.43: Claude Code loads a file's path rules and nested CLAUDE.md on Read,
// not when Claude reads through graph_read (checked live on 2.1.295: with
// graph_read Claude saw no rules at all). graph_read now adds them. The
// matching cases below are the ones Claude Code itself matched in a live test.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/activity/activity-log.js";
import type { GraphSchema } from "../src/graph/types.js";
import type { ServerContext } from "../src/server/context.js";
import {
  buildRulesFooter,
  expandBraces,
  instructionDocs,
  parseRule,
  rulePathsMatch,
  rulesFooter,
} from "../src/server/instructions.js";
import { handleMcpRequest } from "../src/server/mcp.js";
import { resolvePaths } from "../src/shared/paths.js";

const rule = (paths: string, text: string) => `---\npaths: ${paths}\n---\n${text}\n`;

async function write(root: string, rel: string, text: string): Promise<void> {
  const file = join(root, rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
}

describe("reading a rule's paths", () => {
  it("takes a YAML list, an inline list and a comma string", () => {
    expect(parseRule('---\npaths:\n  - "src/api/**"\n  - lib/*.ts\n---\nbody').paths).toEqual([
      "src/api/**",
      "lib/*.ts",
    ]);
    expect(parseRule(rule('["lib/**", "src/api/**"]', "x")).paths).toEqual([
      "lib/**",
      "src/api/**",
    ]);
    expect(parseRule(rule('"docs/**, src/api/*.ts"', "x")).paths).toEqual([
      "docs/**",
      "src/api/*.ts",
    ]);
  });

  it("never splits inside braces", () => {
    expect(parseRule(rule('"src/{a,b}/**, *.{ts,tsx}"', "x")).paths).toEqual([
      "src/{a,b}/**",
      "*.{ts,tsx}",
    ]);
  });

  it("has no paths without frontmatter, without the key, or when broken", () => {
    expect(parseRule("# just text").paths).toBeNull();
    expect(parseRule("---\nname: x\n---\nbody").paths).toBeNull();
    expect(parseRule('---\npaths: ["a"\n---\nbody').paths).toBeNull();
    expect(parseRule("---\npaths:\n---\nbody").paths).toBeNull();
  });

  it("strips the frontmatter, with CRLF and a BOM", () => {
    const r = parseRule('﻿---\r\npaths: "src/**"\r\n---\r\n- the rule\r\n');
    expect(r.paths).toEqual(["src/**"]);
    expect(r.body.trim()).toBe("- the rule");
  });
});

describe("matching like Claude Code", () => {
  const file = "src/api/orders.ts";
  it.each([
    ["*.ts", true],
    ["src/*.ts", false],
    ["src/**/*.{js,ts}", true],
    ["SRC/api/**", true],
    ["src/api/**", true],
    ["src/ui/**", false],
    ["./src/api/*.ts", true],
    ["**/orders.ts", true],
  ])("%s matches src/api/orders.ts: %s", (pattern, expected) => {
    expect(rulePathsMatch([pattern], file)).toBe(expected);
  });

  it("expands nested braces", () => {
    expect(expandBraces("a/{b,{c,d}}.ts")).toEqual(["a/b.ts", "a/c.ts", "a/d.ts"]);
    expect(expandBraces("no-braces/*.ts")).toEqual(["no-braces/*.ts"]);
    expect(expandBraces("open{only")).toEqual(["open{only"]);
  });
});

describe("which instruction files apply", () => {
  it("collects nested CLAUDE files and matching project and user rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-rules-"));
    const home = await mkdtemp(join(tmpdir(), "syn-rules-home-"));
    await write(root, "CLAUDE.md", "ROOT: loads at session start anyway");
    await write(root, "src/CLAUDE.md", "SRC note");
    await write(root, "src/api/CLAUDE.md", "API note");
    await write(root, "src/api/CLAUDE.local.md", "API local note");
    await write(root, "src/ui/CLAUDE.md", "UI note, other folder");
    await write(root, ".claude/rules/api.md", rule('"src/api/**"', "API rule"));
    await write(root, ".claude/rules/deep/ts.md", rule('"*.ts"', "TS rule"));
    await write(root, ".claude/rules/ui.md", rule('"src/ui/**"', "UI rule"));
    await write(root, ".claude/rules/always.md", "No paths: loads at session start");
    await write(home, ".claude/rules/mine.md", rule('"**/*.ts"', "My rule"));

    const docs = await instructionDocs(root, "src/api/orders.ts", home);
    expect(docs.map((d) => d.readPath)).toEqual([
      "src/CLAUDE.md",
      "src/api/CLAUDE.md",
      "src/api/CLAUDE.local.md",
      ".claude/rules/api.md",
      ".claude/rules/deep/ts.md",
      "~/.claude/rules/mine.md",
    ]);
    expect(docs.find((d) => d.readPath === ".claude/rules/api.md")?.text).toBe("API rule");
    // A file at the root has no folders between it and the root.
    expect((await instructionDocs(root, "index.ts", home)).map((d) => d.readPath)).toEqual([
      ".claude/rules/deep/ts.md",
      "~/.claude/rules/mine.md",
    ]);
  });

  it("finds nothing, and never throws, without any of them", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-rules-none-"));
    expect(await instructionDocs(root, "a/b.ts", root)).toEqual([]);
    expect(await rulesFooter(join(root, "missing"), "a/b.ts", root)).toBe("");
  });

  it("skips a rule file that is too big", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-rules-big-"));
    await write(root, ".claude/rules/big.md", rule('"**"', "x".repeat(40_000)));
    expect(await instructionDocs(root, "a.ts", root)).toEqual([]);
  });
});

describe("the section's text", () => {
  it("shows each file under its path, and nothing for none or when off", () => {
    const out = buildRulesFooter(
      [{ readPath: ".claude/rules/api.md", text: "Validate input." }],
      2000,
    );
    expect(out).toContain("Claude Code loads these when you Read it, but not for graph_read");
    expect(out).toContain("### .claude/rules/api.md\nValidate input.");
    expect(buildRulesFooter([], 2000)).toBe("");
    expect(buildRulesFooter([{ readPath: "a", text: "b" }], 0)).toBe("");
  });

  it("cuts at the limit and says where the rest is", () => {
    const out = buildRulesFooter(
      [
        { readPath: "src/CLAUDE.md", text: "a".repeat(30) },
        { readPath: ".claude/rules/long.md", text: "b".repeat(50) },
        { readPath: ".claude/rules/late.md", text: "c" },
      ],
      40,
    );
    expect(out).toContain(`${"b".repeat(10)}\n[cut: Read(".claude/rules/long.md") for the rest]`);
    expect(out).toContain('[not shown: Read(".claude/rules/late.md")]');
    expect(out).not.toContain("c\n");
  });

  it("has no em or en dashes of its own", () => {
    expect(buildRulesFooter([{ readPath: "a", text: "b" }], 10)).not.toMatch(/[–—]/);
  });
});

describe("graph_read adds the rules", () => {
  async function ctxFor(root: string): Promise<ServerContext> {
    const paths = resolvePaths(root);
    const graph: GraphSchema = {
      root: ".",
      node_count: 2,
      edge_count: 0,
      file_count: 1,
      symbol_count: 1,
      nodes: [
        {
          id: "file:src/api/orders.ts",
          kind: "file",
          path: "src/api/orders.ts",
          ext: ".ts",
          size: 1,
          keywords: [],
          content: "export function createOrder() {\n  return 1;\n}\n",
          file_hash: "h",
        },
        {
          id: "symbol:src/api/orders.ts::createOrder",
          kind: "symbol",
          name: "createOrder",
          file: "src/api/orders.ts",
          symbol_kind: "function",
          start_line: 1,
          end_line: 3,
          signature: "export function createOrder()",
          exported: true,
        } as unknown as GraphSchema["nodes"][number],
      ],
      edges: [],
      generated_at: "1970-01-01T00:00:00.000Z",
      schema_version: 2,
    };
    return {
      paths,
      graph,
      symbolIndex: {},
      activity: new ActivityStore(paths.activityLog),
      home: root,
    };
  }
  const read = async (ctx: ServerContext, target: string) => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "graph_read", arguments: { target } },
      },
      ctx,
    );
    return (res?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  };

  it("on a file and on a symbol, before the edit hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-rules-read-"));
    await write(
      root,
      ".claude/rules/api.md",
      rule('"src/api/**"', "RULE-API-5521: validate input."),
    );
    await write(root, "src/api/CLAUDE.md", "NESTED-9034: cents.");
    const ctx = await ctxFor(root);

    const file = await read(ctx, "src/api/orders.ts");
    expect(file).toContain("RULE-API-5521");
    expect(file).toContain("NESTED-9034");
    expect(file.indexOf("createOrder")).toBeLessThan(file.indexOf("RULE-API-5521"));

    const sym = await read(ctx, "src/api/orders.ts::createOrder");
    expect(sym).toContain("RULE-API-5521");
    expect(sym.indexOf("RULE-API-5521")).toBeLessThan(sym.indexOf("To edit this symbol"));
  });

  it("adds nothing when no rule applies", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-rules-read-none-"));
    await write(root, ".claude/rules/ui.md", rule('"src/ui/**"', "UI rule"));
    const text = await read(await ctxFor(root), "src/api/orders.ts");
    expect(text).toBe("# src/api/orders.ts\n\nexport function createOrder() {\n  return 1;\n}\n");
  });

  it("can be switched off", async () => {
    const root = await mkdtemp(join(tmpdir(), "syn-rules-off-"));
    await write(root, ".claude/rules/api.md", rule('"src/api/**"', "RULE"));
    expect(await rulesFooter(root, "src/api/orders.ts", root, 0)).toBe("");
  });
});
