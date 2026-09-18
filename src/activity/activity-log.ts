// Rolling JSONL log of human activity, written to .synthra-graph/activity.jsonl.
// In-memory ring buffer for fast queries; disk append for durability.
//
// The buffer is bounded (defaults to 100 events) so we don't unbounded-grow
// memory in long sessions. Disk keeps a capped recent tail — see MAX_BYTES.

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileEvent {
  kind: "save" | "create" | "delete";
  path: string;
  ts: string;
}

export interface GitEvent {
  kind: "branch-switch" | "stage" | "unstage" | "diff-change";
  details: Record<string, unknown>;
  ts: string;
}

export type ActivityEvent = FileEvent | GitEvent;

const DEFAULT_RING_SIZE = 100;

/**
 * Disk cap for activity.jsonl.
 *
 * This log is append-only and nothing reads it back: every query is served from
 * the in-memory ring above, and the dashboard's /data payload never touches it.
 * Left uncapped it became the largest file Synthra writes — 3.4 MB across 13
 * projects in 113 days — purely as write amplification. Keep a recent tail for
 * eyeball debugging and drop the rest.
 *
 * Override with SYN_ACTIVITY_LOG_MAX_BYTES; 0 disables the cap.
 */
const DEFAULT_MAX_BYTES = 512 * 1024;

function defaultMaxBytes(): number {
  const raw = process.env.SYN_ACTIVITY_LOG_MAX_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_BYTES;
}

export class ActivityStore {
  private ring: ActivityEvent[] = [];
  private readonly maxRingSize: number;
  private readonly maxBytes: number;
  private readonly persistPath: string;

  constructor(persistPath: string, maxRingSize = DEFAULT_RING_SIZE, maxBytes = defaultMaxBytes()) {
    this.persistPath = persistPath;
    this.maxRingSize = maxRingSize;
    this.maxBytes = maxBytes;
  }

  async add(event: ActivityEvent): Promise<void> {
    this.ring.push(event);
    while (this.ring.length > this.maxRingSize) this.ring.shift();
    await this.persist(event);
  }

  /** Get events newer than `sinceMs` (epoch ms). If omitted, returns the full ring. */
  getEvents(sinceMs?: number): ActivityEvent[] {
    if (!sinceMs || !Number.isFinite(sinceMs)) return this.ring.slice();
    const cutoff = new Date(sinceMs).toISOString();
    return this.ring.filter((e) => e.ts >= cutoff);
  }

  /** Project-relative file paths that have a save/create event newer than `maxAgeMs` ms ago. */
  recentFilePaths(maxAgeMs: number): string[] {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const out = new Set<string>();
    for (const e of this.ring) {
      if ("path" in e && (e.kind === "save" || e.kind === "create") && e.ts >= cutoff) {
        out.add(e.path);
      }
    }
    return Array.from(out);
  }

  size(): number {
    return this.ring.length;
  }

  private async persist(event: ActivityEvent): Promise<void> {
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await appendFile(this.persistPath, JSON.stringify(event) + "\n", "utf8");
      await this.capIfNeeded();
    } catch {
      // Durability is best-effort; an unwritable disk shouldn't crash the server.
    }
  }

  /**
   * Trim to the most recent half of the cap once exceeded.
   *
   * Halving rather than trimming to exactly maxBytes means truncation runs once
   * every few thousand events instead of on every single append past the
   * threshold — the steady state is (cap/2, cap].
   *
   * The cut is made at a newline boundary so no half-written JSON line survives;
   * a reader skipping a corrupt line is a bug this log would otherwise cause
   * forever. A single line longer than the window has no safe cut point, so it
   * is left alone rather than destroyed.
   */
  private async capIfNeeded(): Promise<void> {
    if (this.maxBytes <= 0) return;
    const st = await stat(this.persistPath).catch(() => null);
    if (!st || st.size <= this.maxBytes) return;

    const text = await readFile(this.persistPath, "utf8");
    const keepFrom = text.length - Math.floor(this.maxBytes / 2);
    const cut = text.indexOf("\n", Math.max(0, keepFrom));
    if (cut === -1) return;
    await writeFile(this.persistPath, text.slice(cut + 1), "utf8");
  }
}
