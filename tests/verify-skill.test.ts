// v0.45 (Radar R-004): since Claude Code 2.1.286, a skill named `verify` runs
// right before each commit. Synthra offers one per project, once, built from
// the commands the project documents, and it always waits for the user's OK.

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPending } from "../src/learn/skills.js";
import { detectChecks, offerVerifySkill, verifyBody } from "../src/learn/verify-skill.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

afterEach(() => {
  delete process.env.SYN_SKILL_APPROVAL;
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "syn-verify-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  return root;
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });
const commands = async (files: Record<string, string>) =>
  (await detectChecks(await project(files))).map((c) => c.command);

describe("finding a project's checks", () => {
  it("takes package.json scripts, fastest first, and leaves build out", async () => {
    expect(
      await commands({
        "package.json": pkg({
          build: "tsup",
          test: "vitest run",
          lint: "eslint .",
          check: "biome check .",
          typecheck: "tsc --noEmit",
        }),
      }),
    ).toEqual(["npm run typecheck", "npm run check", "npm run lint", "npm test"]);
  });

  it("skips npm's placeholder test", async () => {
    expect(
      await commands({
        "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1', lint: "x" }),
      }),
    ).toEqual(["npm run lint"]);
  });

  it("uses the project's package manager", async () => {
    const scripts = pkg({ typecheck: "tsc", test: "vitest" });
    expect(await commands({ "package.json": scripts, "pnpm-lock.yaml": "" })).toEqual([
      "pnpm run typecheck",
      "pnpm test",
    ]);
    expect(await commands({ "package.json": scripts, "yarn.lock": "" })).toEqual([
      "yarn typecheck",
      "yarn test",
    ]);
    expect(await commands({ "package.json": scripts, "bun.lockb": "" })).toEqual([
      "bun run typecheck",
      "bun run test",
    ]);
  });

  it("knows Python, Rust and Go tools", async () => {
    expect(
      await commands({
        "pyproject.toml":
          "[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n\n[tool.pytest.ini_options]\n",
        "uv.lock": "",
      }),
    ).toEqual(["uv run ruff check .", "uv run mypy .", "uv run pytest"]);
    expect(await commands({ "Cargo.toml": "[package]\n" })).toEqual(["cargo check", "cargo test"]);
    expect(await commands({ "go.mod": "module x\n" })).toEqual(["go vet ./...", "go test ./..."]);
  });

  it("runs a small Python project's test files with unittest, or pytest when it is required", async () => {
    expect(await commands({ "test_app.py": "import unittest\n", "app.py": "" })).toEqual([
      "python -m unittest",
    ]);
    expect(
      await commands({ "tests/test_app.py": "", "requirements-dev.txt": "pytest==8.0\nruff\n" }),
    ).toEqual(["python -m pytest"]);
    expect(await commands({ "app.py": "", "requirements.txt": "flask\n" })).toEqual([]);
  });

  it("uses a Makefile only when nothing else documents the checks", async () => {
    const make = "build:\n\tgo build\n\nlint:\n\tgolint\n\ntest:\n\tgo test\n";
    expect(await commands({ Makefile: make })).toEqual(["make lint", "make test"]);
    expect(await commands({ Makefile: make, "package.json": pkg({ test: "jest" }) })).toEqual([
      "npm test",
    ]);
  });

  it("finds nothing in a project without them, or with a broken package.json", async () => {
    expect(await commands({ "index.html": "<p>hi</p>" })).toEqual([]);
    expect(await commands({ "package.json": "{not json" })).toEqual([]);
  });

  it("writes the checks as numbered steps", () => {
    const body = verifyBody([{ command: "npm run typecheck" }, { command: "npm test" }]);
    expect(body).toContain("1. `npm run typecheck`\n2. `npm test`");
    expect(body).toContain("Commit only when every check passes.");
  });
});

describe("offering the verify skill", () => {
  async function setup(files: Record<string, string>): Promise<SynthraPaths> {
    const root = await project(files);
    const home = await mkdtemp(join(tmpdir(), "syn-verify-home-"));
    return {
      ...resolvePaths(root),
      globalSkillsDir: join(home, ".claude", "skills"),
      skillState: join(home, ".synthra", "skills"),
    };
  }
  const withChecks = { "package.json": pkg({ typecheck: "tsc", test: "vitest" }) };

  it("proposes it once, waiting for the user's OK even with approval off", async () => {
    process.env.SYN_SKILL_APPROVAL = "0";
    const paths = await setup(withChecks);
    await mkdir(paths.graphDir, { recursive: true });
    expect(await offerVerifySkill(paths)).toBe("offered");
    const waiting = await listPending(paths.skillState);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ action: "create", name: "verify", scope: "project" });
    expect(waiting[0]?.after).toContain("1. `npm run typecheck`");
    // Never again for this project, whatever the answer.
    expect(await offerVerifySkill(paths)).toBe("already-offered");
    const marker = JSON.parse(await readFile(join(paths.graphDir, "verify_offered.json"), "utf8"));
    expect(marker.checks).toEqual(["npm run typecheck", "npm test"]);
  });

  it("stays out of the way when a verify skill exists, here or in the user's skills", async () => {
    const here = await setup(withChecks);
    await mkdir(here.graphDir, { recursive: true });
    await mkdir(join(here.projectSkillsDir, "verify"), { recursive: true });
    await writeFile(join(here.projectSkillsDir, "verify", "SKILL.md"), "recorded by /verify");
    expect(await offerVerifySkill(here)).toBe("has-verify");

    const personal = await setup(withChecks);
    await mkdir(personal.graphDir, { recursive: true });
    await mkdir(join(personal.globalSkillsDir, "verify"), { recursive: true });
    await writeFile(join(personal.globalSkillsDir, "verify", "SKILL.md"), "mine");
    expect(await offerVerifySkill(personal)).toBe("has-verify");
    expect(await listPending(personal.skillState)).toEqual([]);
  });

  it("offers nothing without checks", async () => {
    const paths = await setup({ "README.md": "# hi" });
    await mkdir(paths.graphDir, { recursive: true });
    expect(await offerVerifySkill(paths)).toBe("no-checks");
    expect(await listPending(paths.skillState)).toEqual([]);
  });
});
