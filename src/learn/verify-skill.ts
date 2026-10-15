// The `verify` skill (v0.45, Radar R-004). Since Claude Code 2.1.286, a
// project or personal skill named `verify` is one Claude is told to run right
// before each commit (docs-only and tests-only commits aside). So Synthra
// offers one per project, built from the commands the project already
// documents: its package.json scripts, its Python, Rust and Go tools, or its
// Makefile targets. It is offered once, waits for the user's OK in the
// Learning tab even when approval is off, and is never offered again for
// that project, whatever the answer.
//
// A project `verify` skill replaces Claude Code's built-in /verify (which
// builds and drives the app) when typed by hand: fast, repeatable checks
// before each commit are worth more. An existing `verify` skill anywhere (project or
// personal, including one /verify recorded) means no offer.

import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";
import { createSkill, listPending, skillPath } from "./skills.js";

export const VERIFY_SKILL = "verify";

/** One check to run: a command as the user would type it. */
export interface Check {
  command: string;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const readText = (p: string) => readFile(p, "utf8").catch(() => null);

/** package.json script names, in the order the checks run: the fast ones
 *  first, so a type error stops before the tests start. `build` is left out:
 *  slow, and a type check covers most of what it would find. */
const SCRIPT_ORDER = [
  ["typecheck", "type-check", "check-types", "tsc"],
  ["check"],
  ["lint"],
  ["test"],
];

/** npm's placeholder: `echo "Error: no test specified" && exit 1`. */
const PLACEHOLDER_TEST = /no test specified/i;

async function nodeChecks(root: string): Promise<Check[]> {
  const raw = await readText(join(root, "package.json"));
  if (!raw) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const runner = (await exists(join(root, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(join(root, "yarn.lock")))
      ? "yarn"
      : (await exists(join(root, "bun.lockb"))) || (await exists(join(root, "bun.lock")))
        ? "bun"
        : "npm";
  const checks: Check[] = [];
  for (const names of SCRIPT_ORDER) {
    const name = names.find((n) => typeof scripts[n] === "string");
    if (!name) continue;
    if (name === "test" && PLACEHOLDER_TEST.test(String(scripts[name]))) continue;
    const command =
      runner === "yarn"
        ? `yarn ${name}`
        : name === "test" && runner !== "bun"
          ? `${runner} test`
          : `${runner} run ${name}`;
    checks.push({ command });
  }
  return checks;
}

/** A small Python project with no pyproject.toml: `test_*.py` files at the
 *  root or in tests/, run by pytest when a requirements file names it, else
 *  by the standard library's unittest. */
async function plainPythonChecks(root: string): Promise<Check[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const testsDir = await readdir(join(root, "tests")).catch(() => [] as string[]);
  const isTest = (n: string) => /^test_.*\.py$/.test(n);
  if (!names.some(isTest) && !testsDir.some(isTest)) return [];
  for (const n of names.filter((x) => /^requirements.*\.txt$/.test(x))) {
    if (/^\s*pytest\b/m.test((await readText(join(root, n))) ?? "")) {
      return [{ command: "python -m pytest" }];
    }
  }
  return [{ command: "python -m unittest" }];
}

async function pythonChecks(root: string): Promise<Check[]> {
  const toml = await readText(join(root, "pyproject.toml"));
  if (toml === null) return plainPythonChecks(root);
  const prefix = (await exists(join(root, "uv.lock")))
    ? "uv run "
    : (await exists(join(root, "poetry.lock")))
      ? "poetry run "
      : "";
  const checks: Check[] = [];
  if (/^\[tool\.ruff/m.test(toml)) checks.push({ command: `${prefix}ruff check .` });
  if (/^\[tool\.mypy/m.test(toml)) checks.push({ command: `${prefix}mypy .` });
  if (/^\[tool\.pytest/m.test(toml) || /\bpytest\b/.test(toml)) {
    checks.push({ command: `${prefix}pytest` });
  }
  return checks;
}

async function makeChecks(root: string): Promise<Check[]> {
  const text = await readText(join(root, "Makefile"));
  if (!text) return [];
  return ["check", "lint", "test"]
    .filter((t) => new RegExp(`^${t}\\s*:`, "m").test(text))
    .map((t) => ({ command: `make ${t}` }));
}

/** The checks a project documents, from its root folder. Empty: none found. */
export async function detectChecks(root: string): Promise<Check[]> {
  const found = [...(await nodeChecks(root)), ...(await pythonChecks(root))];
  if (await exists(join(root, "Cargo.toml"))) {
    found.push({ command: "cargo check" }, { command: "cargo test" });
  }
  if (await exists(join(root, "go.mod"))) {
    found.push({ command: "go vet ./..." }, { command: "go test ./..." });
  }
  // A Makefile often wraps the commands above; use it only on its own.
  if (found.length === 0) found.push(...(await makeChecks(root)));
  return found;
}

/** The skill's text, from the checks. */
export function verifyBody(checks: Check[]): string {
  return [
    "Run this project's checks before you commit, and fix what fails.",
    "",
    ...checks.map((c, i) => `${i + 1}. \`${c.command}\``),
    "",
    "Run them in this order. When one fails, fix the cause and run the checks again from the first.",
    "Commit only when every check passes.",
    "If a check can't run here (a missing tool, service or secret), say so plainly instead of skipping it.",
  ].join("\n");
}

export const VERIFY_DESCRIPTION =
  "Use right before committing, or when asked to verify the project: runs this project's own checks (type check, lint, tests) and fixes what fails.";

const offeredFile = (paths: SynthraPaths) => join(paths.graphDir, "verify_offered.json");

/** Offer a `verify` skill for this project, once. Returns what happened, for
 *  the log and the tests. Never throws. */
export async function offerVerifySkill(
  paths: SynthraPaths,
): Promise<"offered" | "already-offered" | "has-verify" | "no-checks" | "failed"> {
  try {
    if (await exists(offeredFile(paths))) return "already-offered";
    const project = skillPath(paths, "project", VERIFY_SKILL);
    const personal = skillPath(paths, "global", VERIFY_SKILL);
    const waiting = (await listPending(paths.skillState)).some(
      (p) => p.name === VERIFY_SKILL && (p.path === project || p.path === personal),
    );
    if (waiting || (await exists(project)) || (await exists(personal))) return "has-verify";
    const checks = await detectChecks(paths.projectRoot);
    if (checks.length === 0) return "no-checks";
    const outcome = await createSkill(
      paths,
      {
        scope: "project",
        name: VERIFY_SKILL,
        description: VERIFY_DESCRIPTION,
        body: verifyBody(checks),
        reason:
          "Claude Code runs a skill named verify before each commit. Built from this project's own commands, so commits only happen when they pass.",
      },
      { mustWait: true },
    );
    if (outcome.status === "error") {
      log.warn(`verify skill: ${outcome.error}`);
      return "failed";
    }
    // Once per project, whatever the user answers.
    await writeFile(
      offeredFile(paths),
      `${JSON.stringify({ offeredAt: new Date().toISOString(), checks: checks.map((c) => c.command) })}\n`,
      "utf8",
    );
    return "offered";
  } catch (err) {
    log.warn(`verify skill: ${(err as Error).message}`);
    return "failed";
  }
}
