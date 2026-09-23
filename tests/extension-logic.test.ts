// The IDE extension's decision logic (extension/src/logic.ts). The extension
// has no test harness of its own; these are the parts that are pure, and the
// parts easiest to get subtly wrong — above all the three-version update rule.

import { describe, it, expect } from "vitest";

import {
  adviseUpdate,
  compareVersions,
  type DoctorCheck,
  parseVersion,
  problemSignature,
  shouldNotify,
  worstOf,
} from "../extension/src/logic.js";

describe("versions", () => {
  it("parses a plain version and a `syn --version` line", () => {
    expect(parseVersion("0.31.1")).toEqual([0, 31, 1]);
    expect(parseVersion("syn, 0.31.1")).toEqual([0, 31, 1]);
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it("compares numerically, not as strings", () => {
    // "0.9.0" > "0.10.0" as strings — the classic bug.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.31.1", "0.31.1")).toBe(0);
    expect(compareVersions("0.31.0", "0.31.1")).toBeLessThan(0);
  });

  it("treats an unreadable side as equal, so it never prompts", () => {
    expect(compareVersions("0.32.0", null)).toBe(0);
    expect(compareVersions(undefined, "0.32.0")).toBe(0);
  });
});

describe("adviseUpdate — three versions", () => {
  it("offers an update when npm is ahead of what's installed", () => {
    expect(adviseUpdate({ latest: "0.32.1", installed: "0.32.0", running: "0.32.0" })).toEqual({
      kind: "update",
      latest: "0.32.1",
      current: "0.32.0",
    });
  });

  // THE multi-window case. Window 1 updated; this window still runs the old
  // code. Compared against npm alone it would offer an install that's already
  // done, forever. The fix it needs is a restart.
  it("offers a restart when the disk is ahead of this window's server", () => {
    expect(adviseUpdate({ latest: "0.32.1", installed: "0.32.1", running: "0.32.0" })).toEqual({
      kind: "restart",
      installed: "0.32.1",
      running: "0.32.0",
    });
  });

  it("says nothing when all three agree", () => {
    expect(adviseUpdate({ latest: "0.32.0", installed: "0.32.0", running: "0.32.0" }).kind).toBe(
      "none",
    );
  });

  it("respects a skipped version, and offers the next one", () => {
    const base = { installed: "0.32.0", running: "0.32.0", skipped: "0.32.1" };
    expect(adviseUpdate({ ...base, latest: "0.32.1" }).kind).toBe("none");
    expect(adviseUpdate({ ...base, latest: "0.32.2" }).kind).toBe("update");
  });

  it("falls back to the running version when `syn --version` couldn't run", () => {
    expect(adviseUpdate({ latest: "0.32.1", installed: null, running: "0.32.0" }).kind).toBe(
      "update",
    );
  });

  it("stays quiet when npm couldn't be reached", () => {
    expect(adviseUpdate({ latest: null, installed: "0.32.0", running: "0.32.0" }).kind).toBe(
      "none",
    );
  });

  // A dev build newer than npm must not be told to "update" backwards.
  it("never offers a downgrade", () => {
    expect(adviseUpdate({ latest: "0.31.1", installed: "0.32.0", running: "0.32.0" }).kind).toBe(
      "none",
    );
  });
});

describe("health notifications", () => {
  const c = (status: DoctorCheck["status"], label: string): DoctorCheck => ({
    status,
    label,
    detail: "",
  });

  it("identifies the problem set regardless of check order", () => {
    const a = problemSignature([c("warn", "Hooks"), c("ok", "Graph"), c("fail", "MCP server")]);
    const b = problemSignature([c("fail", "MCP server"), c("warn", "Hooks")]);
    expect(a).toBe(b);
    expect(problemSignature([c("ok", "Graph")])).toBe("");
  });

  // The status bar always tells the truth; the popup is for news. A warning
  // the user can't fix right now must not toast on every window open.
  it("notifies once per new problem set", () => {
    const sig = problemSignature([c("warn", "Hooks")]);
    expect(shouldNotify(sig, undefined)).toBe(true);
    expect(shouldNotify(sig, sig)).toBe(false);
    expect(shouldNotify(problemSignature([c("fail", "Hooks")]), sig)).toBe(true);
    expect(shouldNotify("", sig)).toBe(false);
  });

  it("ranks fail over warn over ok", () => {
    expect(worstOf([c("ok", "a"), c("warn", "b")])).toBe("warn");
    expect(worstOf([c("warn", "a"), c("fail", "b")])).toBe("fail");
    expect(worstOf([])).toBe("ok");
  });
});
