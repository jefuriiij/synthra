<script lang="ts">
  import { store } from "$lib/store.svelte";
  import { fmtAgo, fmtCost } from "$lib/format";
  import { HOOK_COLS, HOOKS_STATE_LABEL, behind, isActive, lastActive } from "$lib/health";
  import type { ProjectHealth } from "$lib/types";

  const health = $derived(store.overview?.health ?? []);
  const spend = $derived(new Map((store.overview?.projects ?? []).map((p) => [p.path, p.spend])));
  const byLast = (a: ProjectHealth, b: ProjectHealth) => lastActive(b) - lastActive(a);
  const active = $derived(health.filter((h) => isActive(h)).sort(byLast));
  const older = $derived(health.filter((h) => !isActive(h)).sort(byLast));
  let showOlder = $state(false);
  const rows = $derived(showOlder || active.length === 0 ? [...active, ...older] : active);
  const label = (key: string, iso: string | undefined) => (!iso && key === "start" ? "not yet" : fmtAgo(iso));
  const open = (h: ProjectHealth) => store.go({ kind: "project", path: h.path });
</script>

{#if health.length === 0}
  <p class="text-sm text-muted-foreground">No project yet.</p>
{:else}
  <div class="overflow-x-auto">
    <table class="w-full border-collapse text-[13.5px]">
      <thead>
        <tr class="text-left font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground/70">
          <th class="pb-2.5 pr-3 font-medium">Project</th>
          {#each HOOK_COLS as c (c.key)}<th class="pb-2.5 pr-3 font-medium">{c.label}</th>{/each}
          <th class="pb-2.5 pr-3 font-medium">Map</th>
          <th class="pb-2.5 text-right font-medium">This {store.days === 30 ? "month" : "week"}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as h (h.path)}
          {@const cost = spend.get(h.path) ?? 0}
          <tr class="cursor-pointer border-t border-border transition-colors hover:bg-ring/5" onclick={() => open(h)}>
            <td class="py-2.5 pr-3">
              <button type="button" class="text-left font-medium text-foreground hover:text-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onclick={(e) => { e.stopPropagation(); open(h); }}>
                {h.name}
              </button>
              <div class={"font-mono text-xs " + (h.hooks_state === "current" || h.hooks_state === "newer" ? "text-muted-foreground/70" : "text-sonnet")}>
                {h.version ? `Synthra ${h.version} · ` : ""}{HOOKS_STATE_LABEL[h.hooks_state]}
              </div>
            </td>
            {#each HOOK_COLS as c (c.key)}
              {@const t = h.hooks[c.key]}
              {@const late = behind(h, c.key)}
              <td class="whitespace-nowrap py-2.5 pr-3">
                <span class={"inline-flex items-center gap-2 font-mono text-[12.5px] " + (late ? "text-sonnet" : "text-muted-foreground")}>
                  <span class={"size-2 rounded-full " + (late ? "bg-sonnet" : t ? "bg-money" : "bg-muted-foreground/40")}></span>
                  {label(c.key, t)}
                </span>
              </td>
            {/each}
            <td class="whitespace-nowrap py-2.5 pr-3 font-mono text-[12.5px] text-muted-foreground">
              {h.map_built_at ? `built ${fmtAgo(h.map_built_at)}` : "not built"}
            </td>
            <td class={"whitespace-nowrap py-2.5 text-right font-mono text-[12.5px] " + (cost > 0 ? "text-money" : "text-muted-foreground/50")}>
              {fmtCost(cost)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if older.length > 0 && active.length > 0}
    <button type="button" class="mt-2.5 text-[13px] text-ring hover:underline" onclick={() => (showOlder = !showOlder)}>
      {showOlder ? "Hide" : "Show"} {older.length} older {older.length === 1 ? "project" : "projects"}
    </button>
  {/if}

  {#each health.filter((h) => h.problem) as h (h.path)}
    <div class="mt-3 flex items-center gap-3.5 rounded-lg border border-sonnet/30 bg-sonnet/5 px-3.5 py-3">
      <p class="flex-1 text-[13.5px] text-foreground/85"><b>{h.name}:</b> {h.problem}</p>
      {#if h.fix === "hooks"}
        <button
          onclick={() => store.fixHooks([h.path])}
          disabled={store.fixing !== null}
          class="whitespace-nowrap rounded-lg border border-border bg-secondary px-3.5 py-1.5 text-[13px] font-medium disabled:opacity-60"
        >
          {store.fixing === h.path ? "Fixing…" : "Fix hooks"}
        </button>
      {/if}
    </div>
  {/each}

  {#if store.fixed}
    <p class={"mt-3 text-[13px] " + (store.fixed.ok ? "text-money" : "text-destructive")}>{store.fixed.text}</p>
  {/if}
  <p class="mt-3 text-xs text-muted-foreground/70">
    "Session start" shows from Synthra 0.34 on. Before that, the other columns come from the logs each part writes.
  </p>
{/if}
