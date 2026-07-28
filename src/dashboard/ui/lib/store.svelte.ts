// Reactive dashboard state (Svelte 5 runes). Polls /data every 10s; lazy-loads
// /arsenal the first time the Arsenal view opens. The view selector lives here
// so the sidebar and main area stay in sync.

import { detailKey } from "./arsenal-detail";
import type {
  ArsenalData,
  ArsenalDetail,
  ArsenalItem,
  ArsenalKind,
  DashboardData,
  ReportData,
  View,
} from "./types";

class DashStore {
  data = $state<DashboardData | null>(null);
  arsenal = $state<ArsenalData | null>(null);
  status = $state<"connecting" | "live" | "offline">("connecting");
  clock = $state("");
  view = $state<View>("overview");
  arsenalLoading = $state(false);
  #arsenalLoaded = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  async tick(): Promise<void> {
    try {
      const r = await fetch("/data");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.data = (await r.json()) as DashboardData;
      this.status = "live";
      this.clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      this.status = "offline";
    }
  }

  start(): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), 10_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  report = $state<ReportData | null>(null);
  reportLoading = $state(false);

  /** Fetch the diagnostic for the Report dialog. No cache — the doctor state
   *  can change between opens (e.g. jq just installed). */
  async loadReport(): Promise<void> {
    this.reportLoading = true;
    try {
      const r = await fetch("/report");
      if (r.ok) this.report = (await r.json()) as ReportData;
    } catch {
      // dialog shows its offline/empty state
    } finally {
      this.reportLoading = false;
    }
  }

  async loadArsenal(force = false): Promise<void> {
    if (this.#arsenalLoaded && !force) return;
    this.arsenalLoading = true;
    // A rescan must also drop cached bodies, or ↻ Rescan refreshes the list
    // while the modal keeps serving the pre-edit source of a skill.
    if (force) this.#detailCache.clear();
    try {
      const r = await fetch("/arsenal");
      if (r.ok) {
        this.arsenal = (await r.json()) as ArsenalData;
        this.#arsenalLoaded = true;
      }
    } catch {
      // leave arsenal as-is; the view shows an error/empty state
    } finally {
      this.arsenalLoading = false;
    }
  }

  arsenalDetail = $state<ArsenalDetail | null>(null);
  arsenalDetailLoading = $state(false);
  arsenalDetailError = $state(false);
  #detailCache = new Map<string, ArsenalDetail>();
  // Monotonic request id: clicking card B while A is still in flight must not
  // let A's response paint over B. Only the newest request may write state.
  #detailSeq = 0;

  /** Full source for one item — backs the detail modal. */
  async loadArsenalDetail(kind: ArsenalKind, item: ArsenalItem): Promise<void> {
    const key = detailKey(kind, item);
    const seq = ++this.#detailSeq;
    this.arsenalDetailError = false;

    const hit = this.#detailCache.get(key);
    if (hit) {
      this.arsenalDetail = hit;
      this.arsenalDetailLoading = false;
      return;
    }
    this.arsenalDetail = null;
    this.arsenalDetailLoading = true;
    try {
      const qs = new URLSearchParams({ kind, scope: item.scope, name: item.name });
      if (item.source) qs.set("source", item.source);
      const r = await fetch(`/arsenal/item?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as ArsenalDetail;
      this.#detailCache.set(key, d); // cache even if this request lost the race
      if (seq !== this.#detailSeq) return;
      this.arsenalDetail = d;
    } catch {
      if (seq === this.#detailSeq) this.arsenalDetailError = true;
    } finally {
      if (seq === this.#detailSeq) this.arsenalDetailLoading = false;
    }
  }

  /** Modal closed — bump the seq so a late response can't repopulate it. */
  clearArsenalDetail(): void {
    this.#detailSeq += 1;
    this.arsenalDetail = null;
    this.arsenalDetailLoading = false;
    this.arsenalDetailError = false;
  }

  go(view: View): void {
    this.view = view;
    if (view === "arsenal") void this.loadArsenal();
  }
}

export const store = new DashStore();
