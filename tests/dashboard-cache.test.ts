// The /data poll is unconditional: the dashboard asks every 10 seconds whether
// or not anything happened, and computeDashboardData re-read and re-parsed
// every log of every registered project each time. Most polls find the logs
// byte-identical to the last one.
//
// logsFingerprint is the change-detector that makes skipping those polls safe.
// It must be cheap (stat only, no content read) and it must not throw on a
// missing file — logs materialise as features get used, and that appearance is
// itself a change worth invalidating on.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearDashboardCache,
  computeDashboardData,
  logsFingerprint,
} from "../src/dashboard/delta.js";
import { resolvePaths, type SynthraPaths } from "../src/shared/paths.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "syn-fp-"));
}

describe("logsFingerprint", () => {
  it("is stable when nothing changes", async () => {
    const d = await tmp();
    const f = join(d, "a.jsonl");
    await writeFile(f, '{"ts":"1"}\n', "utf8");
    expect(await logsFingerprint([f])).toBe(await logsFingerprint([f]));
  });

  it("changes when a log grows", async () => {
    const d = await tmp();
    const f = join(d, "a.jsonl");
    await writeFile(f, '{"ts":"1"}\n', "utf8");
    const before = await logsFingerprint([f]);
    await writeFile(f, '{"ts":"1"}\n{"ts":"2"}\n', "utf8");
    expect(await logsFingerprint([f])).not.toBe(before);
  });

  it("changes when a log appears", async () => {
    // A project's first gate block creates gate_log.jsonl. Treating the
    // missing->present transition as "no change" would pin a stale payload.
    const d = await tmp();
    const f = join(d, "late.jsonl");
    const before = await logsFingerprint([f]);
    await writeFile(f, '{"ts":"1"}\n', "utf8");
    expect(await logsFingerprint([f])).not.toBe(before);
  });

  it("changes when a log disappears", async () => {
    const d = await tmp();
    const f = join(d, "gone.jsonl");
    await writeFile(f, '{"ts":"1"}\n', "utf8");
    const before = await logsFingerprint([f]);
    await rm(f);
    expect(await logsFingerprint([f])).not.toBe(before);
  });

  it("does not throw on a missing file", async () => {
    const d = await tmp();
    await expect(logsFingerprint([join(d, "nope.jsonl")])).resolves.toBeTypeOf("string");
  });

  it("distinguishes two files from one, so order and identity matter", async () => {
    const d = await tmp();
    const a = join(d, "a.jsonl");
    const b = join(d, "b.jsonl");
    await writeFile(a, '{"ts":"1"}\n', "utf8");
    await writeFile(b, '{"ts":"1"}\n', "utf8");
    expect(await logsFingerprint([a, b])).not.toBe(await logsFingerprint([a]));
  });
});

// The fingerprint is only worth having if computeDashboardData actually skips
// work on a hit. These drive the real function against a temp project.
//
// HOME/USERPROFILE is redirected at the same time: computeDashboardData
// enumerates ~/.synthra/projects.json, and reading the developer's real
// registry would make these tests depend on whatever projects happen to be
// registered — and flake outright if a live session appended to a log between
// the two calls. os.homedir() reads the env var on each call, so pointing it at
// an empty temp dir yields an empty registry.
describe("computeDashboardData caching", () => {
  const HOME_VARS = ["HOME", "USERPROFILE"] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    saved = Object.fromEntries(HOME_VARS.map((k) => [k, process.env[k]]));
    const fakeHome = await mkdtemp(join(tmpdir(), "syn-home-"));
    for (const k of HOME_VARS) process.env[k] = fakeHome;
    clearDashboardCache();
  });

  afterEach(() => {
    for (const k of HOME_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearDashboardCache();
  });

  async function project(): Promise<SynthraPaths> {
    const root = await mkdtemp(join(tmpdir(), "syn-dash-"));
    await mkdir(join(root, ".synthra-graph"), { recursive: true });
    return resolvePaths(root);
  }

  it("returns the identical object for an unchanged repeat call", async () => {
    const paths = await project();
    const first = await computeDashboardData(paths);
    const second = await computeDashboardData(paths);
    // Same reference, not merely equal — proves nothing was recomputed.
    expect(second).toBe(first);
  });

  it("recomputes after a log is written", async () => {
    const paths = await project();
    const first = await computeDashboardData(paths);
    await writeFile(
      paths.gateLog,
      JSON.stringify({ ts: new Date().toISOString(), decision: "block", query: "x" }) + "\n",
      "utf8",
    );
    const second = await computeDashboardData(paths);
    expect(second).not.toBe(first);
  });

  it("does not serve a payload built for a different row budget", async () => {
    const paths = await project();
    const wide = await computeDashboardData(paths, 500);
    const narrow = await computeDashboardData(paths);
    expect(narrow).not.toBe(wide);
  });
});
