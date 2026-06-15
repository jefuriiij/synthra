<script lang="ts">
  import { store } from "$lib/store.svelte";
  import { fmt } from "$lib/format";

  const items = $derived.by(() => {
    const g = store.data?.global;
    return [
      { label: "Turns", v: g?.total_turns ?? 0 },
      { label: "↓ Input", v: g?.total_input_tokens ?? 0 },
      { label: "↑ Output", v: g?.total_output_tokens ?? 0 },
      { label: "⟲ Cache R", v: g?.total_cache_read ?? 0 },
      { label: "＋ Cache W", v: g?.total_cache_create ?? 0 },
    ];
  });
</script>

<div class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-5">
  {#each items as it (it.label)}
    <div class="flex flex-col gap-1 bg-card/70 p-4">
      <span class="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{it.label}</span>
      <span class="font-mono text-2xl tabular-nums text-foreground">{fmt(it.v)}</span>
    </div>
  {/each}
</div>
