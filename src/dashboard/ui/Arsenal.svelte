<script lang="ts">
  // Arsenal browser: pick a source on the left, see its items on the right.
  //
  // Class-name convention (dashboard-wide): layout elements carry a `syn-`
  // prefixed semantic class FIRST, then Tailwind utilities — e.g.
  // `class="syn-arsenal-items min-h-0 flex-1 overflow-y-auto"`. Nothing styles
  // these; they exist so a region can be found by grep or in devtools.
  import {
    buildGroups,
    favoriteKey,
    filterItems,
    GROUP_ALL,
    GROUP_FAVORITES,
    itemKey,
    itemsForSelection,
    resolveSelection,
    scopeColor,
    startsNewBand,
  } from "$lib/arsenal-groups";
  import { store } from "$lib/store.svelte";
  import type { ArsenalItem as Item, ArsenalKind } from "$lib/types";
  import ArsenalDetail from "./ArsenalDetail.svelte";
  import ArsenalItem from "./ArsenalItem.svelte";

  let tab = $state<ArsenalKind>("skills");
  let q = $state("");
  let selected = $state<string>(GROUP_ALL);

  // One modal for the whole grid, following whichever card was clicked.
  let detailItem = $state<Item | null>(null);
  let detailOpen = $state(false);

  function openDetail(it: Item) {
    detailItem = it;
    detailOpen = true;
  }

  const a = $derived(store.arsenal);
  const tabs: { id: ArsenalKind; label: string }[] = [
    { id: "skills", label: "Skills" },
    { id: "agents", label: "Agents" },
    { id: "mcp", label: "MCP" },
  ];

  const groups = $derived(
    buildGroups(filterItems(a ? a[tab] : [], q), { kind: tab, favorites: store.favorites }),
  );
  // One stable reference for the whole grid rather than a closure per card.
  function toggleFav(it: Item) {
    void store.toggleFavorite(tab, it);
  }
  // A selection goes stale when the tab changes, a filter empties a group, or a
  // rescan drops a plugin — fall back to All rather than rendering nothing.
  const active = $derived(resolveSelection(groups, selected));
  const shown = $derived(itemsForSelection(groups, active));

  const scanned = $derived(
    a ? new Date(a.scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
  );
</script>

<div class="syn-arsenal flex h-full min-h-0 flex-col gap-4 overflow-hidden p-5">
  <div class="syn-arsenal-header flex flex-wrap items-center justify-between gap-3">
    <h1 class="font-serif text-2xl text-foreground">⚔ Arsenal</h1>
    <div class="flex items-center gap-2 font-mono text-xs text-muted-foreground">
      {#if store.favoriteError}
        <!-- No toast system in this dashboard; a quiet inline line is the whole
             failure surface for a favorite that didn't save. -->
        <span class="syn-arsenal-fav-error" role="status" aria-live="polite" style="color: var(--c-opus)"
          >{store.favoriteError}</span
        >
      {/if}
      {#if a}<span>{a.counts.plugins} plugins · scanned {scanned}</span>{/if}
      <button
        onclick={() => store.loadArsenal(true)}
        class="rounded border px-2 py-1 transition-colors hover:text-foreground">↻ Rescan</button
      >
    </div>
  </div>

  <div class="syn-arsenal-toolbar flex flex-wrap items-center gap-2">
    {#each tabs as t (t.id)}
      <button
        onclick={() => (tab = t.id)}
        class={"syn-arsenal-tab rounded-lg px-3 py-1.5 font-mono text-xs transition-colors " +
          (tab === t.id
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:text-foreground")}
      >
        {t.label} <span class="opacity-60">{a?.counts?.[t.id] ?? 0}</span>
      </button>
    {/each}
    <input
      bind:value={q}
      name="arsenal-filter"
      aria-label="Filter the arsenal by name or description"
      placeholder="Filter by name or description…"
      autocomplete="off"
      class="syn-arsenal-search ml-auto w-full max-w-72 rounded-md border bg-card/60 px-3 py-1.5 text-sm outline-none transition-colors focus:border-ring"
    />
  </div>

  {#if store.arsenalLoading && !a}
    <div class="text-sm text-muted-foreground">Scanning your arsenal…</div>
  {:else}
    <div class="syn-arsenal-body flex min-h-0 flex-1 gap-4">
      <!-- Left: one row per source; counts follow the active filter. -->
      <div
        class="syn-arsenal-groups flex w-56 shrink-0 flex-col gap-1 overflow-y-auto pr-1"
        aria-label="Arsenal groups"
      >
        {#each groups as g, i (g.key)}
          {#if startsNewBand(groups, i)}
            <div class="syn-arsenal-groups-divider my-1 h-px shrink-0 bg-border"></div>
          {/if}
          <button
            onclick={() => (selected = g.key)}
            title={g.label}
            class={"syn-arsenal-group flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors " +
              (active === g.key
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground")}
          >
            <span class="size-1.5 shrink-0 rounded-sm" style={`background:${scopeColor(g.scope)}`}
            ></span>
            <span class="min-w-0 truncate">{g.label}</span>
            <span class="ml-auto shrink-0 font-mono text-xs opacity-60">{g.items.length}</span>
          </button>
        {:else}
          <div class="text-sm text-muted-foreground">No matches.</div>
        {/each}
      </div>

      <!-- Right: the selected group's items. -->
      <div class="syn-arsenal-items min-h-0 flex-1 overflow-y-auto pr-1">
        {#if shown.length}
          <div class="syn-arsenal-item-grid grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {#each shown as it (itemKey(it))}
              <!-- The Favorites row mixes scopes and plugins, so keep the badge
                   there — unlike a plugin row, where every card is identical. -->
              <ArsenalItem
                item={it}
                showBadge={active === GROUP_ALL || active === GROUP_FAVORITES}
                favorite={store.favorites.has(favoriteKey({ ...it, kind: tab }))}
                onOpen={openDetail}
                onToggleFavorite={tab === "mcp" ? undefined : toggleFav}
              />
            {/each}
          </div>
        {:else}
          <div class="text-sm text-muted-foreground">
            {q ? "No matches." : "Nothing installed in this category."}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<ArsenalDetail bind:open={detailOpen} item={detailItem} kind={tab} />

