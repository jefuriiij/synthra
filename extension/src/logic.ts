// Pure decision logic for the extension — no `vscode` import, so the main
// Synthra test suite can exercise it (the extension has no test harness of its
// own, and these are the parts that are easy to get subtly wrong).

export type Health = "ok" | "warn" | "fail";

export interface DoctorCheck {
  status: Health;
  label: string;
  detail: string;
}

/** `GET /doctor` on the running server (CLI 0.32+). */
export interface DoctorReport {
  version: string;
  status: Health;
  checks: DoctorCheck[];
}

// ─── versions ────────────────────────────────────────────────────────────────

/** "0.31.1" → [0, 31, 1]. Pre-release tags are ignored: Synthra doesn't ship
 *  them, and treating "0.32.0-beta" as 0.32.0 errs toward offering the update. */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** >0 when a is newer than b. An unparseable side compares as equal, so a
 *  version we couldn't read never triggers an update or a restart prompt. */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

export type UpdateAdvice =
  | { kind: "none" }
  | { kind: "update"; latest: string; current: string }
  | { kind: "restart"; installed: string; running: string };

/**
 * Three versions, not two:
 *   latest    — what npm has
 *   installed — what `syn --version` says is on disk
 *   running   — what the live server reports
 *
 * "installed" is what makes multi-window work. Update from window 1 and windows
 * 2 and 3 still run the old code in memory. Compared against npm alone, they
 * would offer an update that is already installed, forever. Compared against
 * what's on disk, they offer the thing that actually helps: a restart.
 */
export function adviseUpdate(v: {
  latest: string | null;
  installed: string | null;
  running: string | null;
  skipped?: string | null;
}): UpdateAdvice {
  const current = v.installed ?? v.running;
  if (v.latest && current && compareVersions(v.latest, current) > 0) {
    if (v.skipped && compareVersions(v.latest, v.skipped) <= 0) return { kind: "none" };
    return { kind: "update", latest: v.latest, current };
  }
  if (v.installed && v.running && compareVersions(v.installed, v.running) > 0) {
    return { kind: "restart", installed: v.installed, running: v.running };
  }
  return { kind: "none" };
}

// ─── health notifications ────────────────────────────────────────────────────

/** Worst status in a set of checks. Mirrors the server's worstStatus — the
 *  extension needs it when it merges a light poll with earlier env checks. */
export function worstOf(checks: DoctorCheck[]): Health {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

/** Identifies the current SET of problems, so we can tell a new problem from
 *  one we've already told the user about. "" means healthy. */
export function problemSignature(checks: DoctorCheck[]): string {
  return checks
    .filter((c) => c.status !== "ok")
    .map((c) => `${c.status}:${c.label}`)
    .sort()
    .join("|");
}

/**
 * Pop a notification only for a problem set we haven't shown before.
 *
 * The status bar always tells the truth; the popup is for news. Without this,
 * a warning the user can't fix right now (no `claude` on PATH, say) would toast
 * on every window open and every poll, and a toast that always fires is a
 * toast that gets ignored — including the one time it matters.
 */
export function shouldNotify(signature: string, lastNotified: string | undefined): boolean {
  return signature !== "" && signature !== (lastNotified ?? "");
}
