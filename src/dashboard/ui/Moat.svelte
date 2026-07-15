<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { CountUp } from "$lib/countup";
  import { store } from "$lib/store.svelte";
  import { fmt, fmtTs } from "$lib/format";

  const gates = $derived((store.data?.recent_gates ?? []).slice(0, 50));
  const blocks = $derived(store.data?.global?.blocked_count ?? 0);
  const blocksCounter = new CountUp();
  $effect(() => blocksCounter.set(blocks));

  // Suspected false blocks: blocked, then bypassed via a terminal search (v0.20).
  const bypassed = $derived(store.data?.global?.blocks_bypassed ?? 0);

  // Observe-only: the terminal bypass of the Moat (rg/cat/find via Bash).
  const bashTotal = $derived(store.data?.global?.bash_explorations ?? 0);
  const bashAvoidable = $derived(store.data?.global?.bash_avoidable ?? 0);
  const recentBash = $derived((store.data?.recent_bash ?? []).slice(0, 12));
</script>

<Card title="The Moat" meta="PreToolUse">
  <div class="font-mono text-2xl text-foreground">{fmt(blocksCounter.value)} <span class="text-sm text-muted-foreground">blocks</span></div>
  {#if bashTotal > 0}
    <div class="font-mono text-xs text-muted-foreground" title="Codebase exploration via the terminal (rg / cat / find) — observe-only, not yet blocked">
      ↳ {fmt(bashTotal)} terminal hunts ·
      <span class={bashAvoidable > 0 ? "text-destructive" : ""}>{fmt(bashAvoidable)} the graph could answer</span>
    </div>
  {/if}
  {#if blocks > 0}
    <div
      class="font-mono text-xs text-muted-foreground"
      title="A block followed within 2 minutes by a terminal search sharing its query terms — the agent likely routed around a wrong block"
    >
      ↳ <span class={bypassed > 0 ? "text-destructive" : ""}>{fmt(bypassed)} bypassed via terminal</span> — suspected false blocks
    </div>
  {/if}
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
      <div class="text-sm text-muted-foreground">No gate decisions yet — they land here as the agent searches.</div>
    {/each}

    {#if recentBash.length > 0}
      <div class="mt-2 border-t border-border pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Terminal hunts (observe-only)
      </div>
      {#each recentBash as b (b.ts + b.query)}
        <div class="flex items-baseline gap-2 font-mono text-xs">
          <span class="shrink-0 text-muted-foreground">{fmtTs(b.ts)}</span>
          <span
            class={"shrink-0 rounded px-1 text-[10px] uppercase " +
              (b.avoidable ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}
          >{b.tool}</span>
          <span class="truncate text-foreground/80" title={b.query ?? ""}>{b.query ?? "—"}</span>
        </div>
      {/each}
    {/if}
  </div>
</Card>
