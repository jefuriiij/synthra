// Reactive dashboard state (Svelte 5 runes). Polls /overview every 15s for the
// chosen window and project, runs "Fix hooks", and loads the Report dialog's
// diagnostic on demand.
//
// What is shown lives in the address, so back, reload and bookmarks work:
//   (none)        this window's project
//   #/all         every project
//   #/p/<path>    one project Synthra knows (the server checks it)

import type { OverviewData, ReportData } from "./types";

export type Days = 7 | 30;
export type Route = { kind: "all" } | { kind: "project"; path: string | null };

function readRoute(): Route {
  const h = location.hash;
  if (h === "#/all") return { kind: "all" };
  const m = h.match(/^#\/p\/(.+)$/);
  if (m?.[1]) {
    try {
      return { kind: "project", path: decodeURIComponent(m[1]) };
    } catch {
      // a broken link: this window's project
    }
  }
  return { kind: "project", path: null };
}

/** The same folder, whatever the slashes or (on Windows) the case. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return /^[A-Za-z]:/.test(a) ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

class DashStore {
  overview = $state<OverviewData | null>(null);
  days = $state<Days>(7);
  route = $state<Route>(readRoute());
  status = $state<"connecting" | "live" | "offline">("connecting");
  clock = $state("");
  /** The project whose hooks are being fixed right now. */
  fixing = $state<string | null>(null);
  /** The last Fix hooks result, shown under the health table. */
  fixed = $state<{ ok: boolean; text: string } | null>(null);
  #timer: ReturnType<typeof setInterval> | null = null;
  #onHash = () => {
    this.route = readRoute();
    void this.tick();
  };

  /** The project the page is about: the route's, else this window's. */
  get projectPath(): string | null {
    return this.route.kind === "project"
      ? (this.route.path ?? this.overview?.home?.path ?? this.overview?.project.path ?? null)
      : null;
  }

  /** The overview in hand is about the project on screen (not the last one). */
  get showing(): boolean {
    const want = this.projectPath;
    return !!this.overview && (!want || samePath(this.overview.project.path, want));
  }

  async tick(): Promise<void> {
    const r = this.route;
    const project = r.kind === "project" && r.path ? `&project=${encodeURIComponent(r.path)}` : "";
    try {
      const res = await fetch(`/overview?days=${this.days}${project}`);
      if (res.status === 404 && project) {
        // A project Synthra no longer knows: back to this window's.
        this.go({ kind: "project", path: null });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OverviewData;
      // Moved on while this was on its way: drop it.
      if (r !== this.route) return;
      this.overview = data;
      this.status = "live";
      this.clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      this.status = "offline";
    }
  }

  start(): void {
    window.addEventListener("hashchange", this.#onHash);
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), 15_000);
  }

  stop(): void {
    window.removeEventListener("hashchange", this.#onHash);
    if (this.#timer) clearInterval(this.#timer);
  }

  go(route: Route): void {
    const hash =
      route.kind === "all" ? "#/all" : route.path ? `#/p/${encodeURIComponent(route.path)}` : "";
    if (hash === location.hash || (!hash && !location.hash)) {
      this.route = route;
      void this.tick();
    } else if (hash) {
      location.hash = hash;
    } else {
      history.pushState(null, "", location.pathname + location.search);
      this.#onHash();
    }
    window.scrollTo({ top: 0 });
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
