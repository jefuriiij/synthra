// Rolling JSONL log of human activity, written to .synthra-graph/activity.jsonl.
// In-memory ring buffer for fast queries; disk append for durability.
//
// The buffer is bounded (defaults to 100 events) so we don't unbounded-grow
// memory in long sessions. Disk gets every event so the dashboard / future
// audit tooling can replay history.

import { appendFile, mkdir } from "node:fs/promises";
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

export class ActivityStore {
  private ring: ActivityEvent[] = [];
  private readonly maxRingSize: number;
  private readonly persistPath: string;

  constructor(persistPath: string, maxRingSize = DEFAULT_RING_SIZE) {
    this.persistPath = persistPath;
    this.maxRingSize = maxRingSize;
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
    } catch {
      // Durability is best-effort; an unwritable disk shouldn't crash the server.
    }
  }
}
