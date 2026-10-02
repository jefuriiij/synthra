// Reactive dashboard state (Svelte 5 runes). Polls /data every 10s and loads
// the Report dialog's diagnostic on demand.

import type { DashboardData, ReportData } from "./types";

class DashStore {
  data = $state<DashboardData | null>(null);
  status = $state<"connecting" | "live" | "offline">("connecting");
  clock = $state("");
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
}

export const store = new DashStore();
