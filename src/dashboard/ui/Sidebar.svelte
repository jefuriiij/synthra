<script lang="ts">
  import { store, samePath } from "$lib/store.svelte";
  import { fmtAgo, fmtCost } from "$lib/format";
  import { isActive, lastActive, projectDot } from "$lib/health";
  import type { ProjectHealth } from "$lib/types";

  const health = $derived(store.overview?.health ?? []);
  const spend = $derived(new Map((store.overview?.projects ?? []).map((p) => [p.path, p.spend])));
  const byLast = (a: ProjectHealth, b: ProjectHealth) => lastActive(b) - lastActive(a);
  const active = $derived(health.filter((h) => isActive(h)).sort(byLast));
  const older = $derived(health.filter((h) => !isActive(h)).sort(byLast));
  const olderWarn = $derived(older.filter((h) => projectDot(h) === "warn").length);
  let showOlder = $state(false);
  const total = $derived(store.overview?.cost.spend ?? 0);
  const home = $derived(store.overview?.home?.path);
  const current = (h: ProjectHealth) => {
    const p = store.projectPath;
    return p !== null && samePath(p, h.path);
  };
  const dotClass = { ok: "bg-money shadow-[0_0_0_3px_rgba(74,222,155,0.12)]", warn: "bg-sonnet shadow-[0_0_0_3px_rgba(255,185,56,0.14)]", idle: "bg-muted-foreground/40" };
  const money = (n: number) => fmtCost(n).replace(/\.\d+$/, "");
</script>

{#snippet item(h: ProjectHealth)}
  {@const dot = projectDot(h)}
  {@const cost = spend.get(h.path) ?? 0}
  <button
    type="button"
    onclick={() => store.go({ kind: "project", path: h.path })}
    aria-current={current(h) ? "page" : undefined}
    title={h.path}
    class={"grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors " +
      (current(h) ? "border-ring/30 bg-accent/60" : "border-transparent hover:bg-secondary/60")}
  >
    <span class={"size-2 rounded-full " + dotClass[dot]} aria-label={dot === "warn" ? "needs a look" : dot === "ok" ? "works" : "quiet"}></span>
    <span class="min-w-0">
      <span class="block truncate text-[13.5px] font-medium text-foreground">
        {h.name}{#if home && samePath(home, h.path)}<span class="ml-1.5 font-mono text-[10.5px] font-normal text-ring">this window</span>{/if}
      </span>
      <span class="block font-mono text-[11px] text-muted-foreground/70">{lastActive(h) ? fmtAgo(new Date(lastActive(h)).toISOString()) : "never ran"}</span>
    </span>
    <span class="font-mono text-[12px] text-muted-foreground">{cost > 0 ? money(cost) : ""}</span>
  </button>
{/snippet}

<nav aria-label="Projects" class="flex flex-col gap-0.5">
  <button
    type="button"
    onclick={() => store.go({ kind: "all" })}
    aria-current={store.route.kind === "all" ? "page" : undefined}
    class={"grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors " +
      (store.route.kind === "all" ? "border-ring/30 bg-accent/60" : "border-transparent hover:bg-secondary/60")}
  >
    <svg viewBox="0 0 16 16" class="size-4 text-ring" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
    <span class="min-w-0">
      <span class="block text-[13.5px] font-medium text-foreground">All projects</span>
      <span class="block font-mono text-[11px] text-muted-foreground/70">{active.length} active · {health.length} known</span>
    </span>
    <span class="font-mono text-[12px] text-muted-foreground">{total > 0 ? money(total) : ""}</span>
  </button>

  {#if active.length > 0}
    <h3 class="mx-2.5 mb-1.5 mt-5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60">Active this week</h3>
    {#each active as h (h.path)}{@render item(h)}{/each}
  {/if}

  {#if older.length > 0}
    <button
      type="button"
      onclick={() => (showOlder = !showOlder)}
      aria-expanded={showOlder}
      class="mt-2 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground hover:text-foreground"
    >
      <span class={"inline-block transition-transform " + (showOlder ? "rotate-90" : "")}>›</span>
      <span>Older projects ({older.length}){#if olderWarn}<span class="text-sonnet"> · {olderWarn} need a look</span>{/if}</span>
    </button>
    {#if showOlder || active.length === 0}
      {#each older as h (h.path)}{@render item(h)}{/each}
    {/if}
  {/if}
</nav>
