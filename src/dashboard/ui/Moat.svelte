<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { store } from "$lib/store.svelte";
  import { fmt, fmtTs } from "$lib/format";

  const gates = $derived((store.data?.recent_gates ?? []).slice(0, 50));
  const blocks = $derived(store.data?.global?.blocked_count ?? 0);
</script>

<Card title="The Moat" meta="PreToolUse">
  <div class="font-mono text-2xl text-foreground">{fmt(blocks)} <span class="text-sm text-muted-foreground">blocks</span></div>
  <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
    {#each gates as g (g.ts + g.query)}
      <div class="flex items-baseline gap-2 font-mono text-xs">
        <span class="shrink-0 text-muted-foreground">{fmtTs(g.ts)}</span>
        <span
          class={"shrink-0 rounded px-1 text-[10px] uppercase " +
            (g.decision === "block" ? "bg-destructive/15 text-destructive" : "bg-[var(--c-fable)]/12 text-[var(--c-fable)]")}
        >{g.decision}</span>
        <span class="truncate text-foreground/80" title={g.query ?? ""}>{g.query ?? "—"}</span>
      </div>
    {:else}
      <div class="text-sm text-muted-foreground">No gate decisions yet.</div>
    {/each}
  </div>
</Card>
