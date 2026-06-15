<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { store } from "$lib/store.svelte";
  import { fmt, shortenPath } from "$lib/format";

  const active = $derived(store.data?.active);
  const files = $derived(active?.stats?.hot_files ?? []);
</script>

<Card title="Hot files" meta={active?.project_name ?? "active project"}>
  <div class="font-mono text-2xl text-foreground">{fmt(active?.stats?.hot_files_total ?? 0)} <span class="text-sm text-muted-foreground">tracked</span></div>
  <div class="flex max-h-[190px] flex-col gap-1.5 overflow-y-auto">
    {#each files as f (f.path)}
      <div class="flex items-baseline justify-between gap-3 font-mono text-sm" title={f.path}>
        <span class="truncate text-muted-foreground">{shortenPath(f.path)}</span>
        <span class="tabular-nums text-foreground">{f.score}</span>
      </div>
    {:else}
      <div class="text-sm text-muted-foreground">No usage learned yet — Synthra learns as you read/edit files.</div>
    {/each}
  </div>
</Card>
