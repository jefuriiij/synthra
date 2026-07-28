// Reactive dashboard state (Svelte 5 runes). Polls /data every 10s; lazy-loads
// /arsenal the first time the Arsenal view opens. The view selector lives here
// so the sidebar and main area stay in sync.

import { detailKey } from "./arsenal-detail";
import { favoriteKey } from "./arsenal-groups";
import type {
  ArsenalData,
  ArsenalDetail,
  ArsenalItem,
  ArsenalKind,
  DashboardData,
  FavoriteEntry,
  FavoritesResponse,
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
      // Both together, so the panel never paints a frame with items but no
      // hearts. Guarded independently: a favorites failure must not blank the
      // arsenal, and vice versa.
      const [items, favorites] = await Promise.all([
        fetch("/arsenal").catch(() => null),
        fetch("/favorites").catch(() => null),
      ]);
      if (items?.ok) {
        this.arsenal = (await items.json()) as ArsenalData;
        this.#arsenalLoaded = true;
      }
      if (favorites?.ok) {
        this.#applyFavorites(((await favorites.json()) as FavoritesResponse).favorites);
      }
    } catch {
      // leave arsenal as-is; the view shows an error/empty state
    } finally {
      this.arsenalLoading = false;
    }
  }

  favorites = $state<ReadonlySet<string>>(new Set());
  favoriteError = $state<string | null>(null);
  // Monotonic, like #detailSeq: a slow response for card A must not stomp the
  // state a later toggle of card B already established.
  #favSeq = 0;
  #favErrorTimer: ReturnType<typeof setTimeout> | undefined;

  #applyFavorites(list: FavoriteEntry[] | undefined): void {
    this.favorites = new Set((list ?? []).map(favoriteKey));
  }

  /**
   * Favorite or unfavorite one item. Optimistic, then reconciled against the
   * server's echoed list; reverts if the write failed, because a heart that
   * silently lies until the next reload is worse than a visible error.
   */
  async toggleFavorite(kind: ArsenalKind, item: ArsenalItem): Promise<void> {
    if (kind === "mcp") return; // no file, nothing to bookmark
    const key = favoriteKey({ ...item, kind });
    const previous = this.favorites;
    const next = !previous.has(key);
    const seq = ++this.#favSeq;

    // Reassign — Svelte 5's $state proxy does not track Set mutations, so
    // `favorites.add(key)` would update nothing.
    const optimistic = new Set(previous);
    if (next) optimistic.add(key);
    else optimistic.delete(key);
    this.favorites = optimistic;
    this.#clearFavoriteError();

    try {
      const r = await fetch("/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          scope: item.scope,
          source: item.source ?? null,
          name: item.name,
          favorite: next,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as FavoritesResponse;
      if (seq === this.#favSeq) this.#applyFavorites(body.favorites);
    } catch {
      if (seq !== this.#favSeq) return; // a newer toggle owns the state now
      this.favorites = previous;
      this.favoriteError = next ? "Couldn't save that favorite." : "Couldn't remove that favorite.";
      this.#favErrorTimer = setTimeout(() => (this.favoriteError = null), 4000);
    }
  }

  #clearFavoriteError(): void {
    clearTimeout(this.#favErrorTimer);
    this.favoriteError = null;
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
