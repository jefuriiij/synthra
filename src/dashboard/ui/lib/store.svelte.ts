// Reactive dashboard state (Svelte 5 runes). Polls /overview every 15s for the
// chosen window, runs "Fix hooks", and loads the Report dialog's diagnostic on
// demand.

import type { OverviewData, ReportData } from "./types";

export type Days = 7 | 30;

class DashStore {
  overview = $state<OverviewData | null>(null);
  days = $state<Days>(7);
  status = $state<"connecting" | "live" | "offline">("connecting");
  clock = $state("");
  /** The project whose hooks are being fixed right now. */
  fixing = $state<string | null>(null);
  /** The last Fix hooks result, shown under the health table. */
  fixed = $state<{ ok: boolean; text: string } | null>(null);
  #timer: ReturnType<typeof setInterval> | null = null;

  async tick(): Promise<void> {
    try {
      const r = await fetch(`/overview?days=${this.days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.overview = (await r.json()) as OverviewData;
      this.status = "live";
      this.clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      this.status = "offline";
    }
  }

  start(): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), 15_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  setDays(days: Days): void {
    if (days === this.days) return;
    this.days = days;
    void this.tick();
  }

  /** Rewrite these projects' hooks (POST /repair, one at a time), then
   *  refresh the page. */
  async fixHooks(paths: string[]): Promise<void> {
    const failed: string[] = [];
    for (const path of paths) {
      this.fixing = path;
      try {
        const r = await fetch("/repair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          failed.push(`${path.split(/[/\\]/).pop()}: ${body.error ?? `HTTP ${r.status}`}`);
        }
      } catch {
        failed.push(`${path.split(/[/\\]/).pop()}: could not reach Synthra`);
      }
    }
    this.fixing = null;
    this.fixed =
      failed.length === 0
        ? { ok: true, text: "Hooks fixed. They work from the next Claude session on." }
        : { ok: false, text: `Some hooks could not be fixed. ${failed.join(". ")}` };
    await this.tick();
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
