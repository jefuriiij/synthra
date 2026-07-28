<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { store } from "$lib/store.svelte";
  import { fmt, fmtCost, fmtTs, modelFamily, modelLabel } from "$lib/format";

  const PER = 25;
  let page = $state(1);

  const turns = $derived(store.data?.recent_turns ?? []);
  const pages = $derived(Math.max(1, Math.ceil(turns.length / PER)));
  $effect(() => {
    if (page > pages) page = pages;
  });
  const slice = $derived(turns.slice((page - 1) * PER, (page - 1) * PER + PER));
  const from = $derived(turns.length ? (page - 1) * PER + 1 : 0);
  const to = $derived(Math.min(page * PER, turns.length));
</script>

<Card title="Recent turns" meta={`showing ${from}–${to} of ${turns.length}`} class="syn-card-turns">
  <div class="min-h-0 flex-1 overflow-x-auto">
    <table class="w-full border-collapse font-mono text-sm">
      <thead>
        <tr class="text-left text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          <th class="py-1.5 pr-2 font-medium">Time</th>
          <th class="py-1.5 pr-2 font-medium">Project</th>
          <th class="py-1.5 pr-2 font-medium">Model</th>
          <th class="py-1.5 pr-2 text-right font-medium">In</th>
          <th class="py-1.5 pr-2 text-right font-medium">Out</th>
          <th class="py-1.5 pr-2 text-right font-medium">Cache R/W</th>
          <th class="py-1.5 text-right font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {#each slice as t (t.ts + t.project_path + t.model)}
          <tr class="border-t border-border/60">
            <td class="py-1.5 pr-2 text-muted-foreground">{fmtTs(t.ts)}</td>
            <td class="max-w-[120px] truncate py-1.5 pr-2 text-foreground" title={t.project_name}>{t.project_name}</td>
            <td class="py-1.5 pr-2">
              <span class="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5" style={`color: var(--c-${modelFamily(t.model)})`}>
                <span class="size-1.5 rounded-sm" style={`background: var(--c-${modelFamily(t.model)})`}></span>
                {modelLabel(t.model)}
              </span>
            </td>
            <td class="py-1.5 pr-2 text-right tabular-nums text-foreground">{fmt(t.input)}</td>
            <td class="py-1.5 pr-2 text-right tabular-nums text-foreground">{fmt(t.output)}</td>
            <td class="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{fmt(t.cache_read)} / {fmt(t.cache_create)}</td>
            <td class="py-1.5 text-right tabular-nums text-[var(--money)]">{fmtCost(t.cost_usd)}</td>
          </tr>
        {:else}
          <tr><td colspan="7" class="py-6 text-center text-muted-foreground">No turns recorded yet — finish a Claude Code turn and it lands here.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if pages > 1}
    <div class="flex items-center justify-end gap-3 pt-1 font-mono text-sm text-muted-foreground">
      <button onclick={() => (page = Math.max(1, page - 1))} disabled={page <= 1} class="rounded border px-2 py-1 disabled:opacity-40 enabled:hover:text-foreground">‹ Prev</button>
      <span>page {page} of {pages}</span>
      <button onclick={() => (page = Math.min(pages, page + 1))} disabled={page >= pages} class="rounded border px-2 py-1 disabled:opacity-40 enabled:hover:text-foreground">Next ›</button>
    </div>
  {/if}
</Card>
