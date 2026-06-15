// Reactive dashboard state (Svelte 5 runes). Polls /data every 10s; lazy-loads
// /arsenal the first time the Arsenal view opens. The view selector lives here
// so the sidebar and main area stay in sync.

import type { ArsenalData, DashboardData, View } from "./types";

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

  async loadArsenal(force = false): Promise<void> {
    if (this.#arsenalLoaded && !force) return;
    this.arsenalLoading = true;
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

  go(view: View): void {
    this.view = view;
    if (view === "arsenal") void this.loadArsenal();
  }
}

export const store = new DashStore();
