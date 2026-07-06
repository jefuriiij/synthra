<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { store } from "$lib/store.svelte";
  import { fmt } from "$lib/format";

  const rows = $derived.by(() => {
    const calls = store.data?.global?.tool_calls ?? {};
    return Object.entries(calls)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  });
  const total = $derived(store.data?.global?.total_tool_calls ?? 0);
</script>

<Card title="Graph tools used" meta="all projects">
  <div class="font-mono text-2xl text-foreground">{fmt(total)} <span class="text-sm text-muted-foreground">calls</span></div>
  <div class="flex flex-col gap-1.5">
    {#each rows as [name, n] (name)}
      <div class="flex items-baseline justify-between font-mono text-sm">
        <span class="text-muted-foreground">{name}</span>
        <span class="tabular-nums text-foreground">{n}</span>
      </div>
    {:else}
      <div class="text-sm text-muted-foreground">No graph-tool calls yet — counts appear as the agent uses Synthra's tools.</div>
    {/each}
  </div>
</Card>
