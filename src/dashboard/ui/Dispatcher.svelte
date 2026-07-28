<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { CountUp } from "$lib/countup";
  import { fmt, fmtTs } from "$lib/format";
  import { store } from "$lib/store.svelte";

  const g = $derived(store.data?.global);
  const total = $derived(g?.routes_total ?? 0);
  const hinted = $derived(g?.routes_hinted ?? 0);
  const complex = $derived(g?.routes_complex ?? 0);
  const standard = $derived(total - complex);
  const followed = $derived(g?.routes_followed ?? 0);
  const followedAgent = $derived(g?.routes_followed_agent ?? 0);
  // v0.21: injection is off by default, so the scorer's confident verdicts
  // ("matched") outnumber the ones actually spoken ("hinted").
  const matched = $derived(g?.routes_matched ?? 0);
  const shadow = $derived(matched > hinted);
  const topAgents = $derived(
    Object.entries(g?.route_agents ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4),
  );
  const routes = $derived((store.data?.recent_routes ?? []).slice(0, 50));

  const hintedCounter = new CountUp();
  $effect(() => hintedCounter.set(hinted));
</script>

<Card
  title="The Dispatcher"
  meta={shadow ? "shadow mode" : "UserPromptSubmit"}
  class="syn-card-dispatcher"
>
  <div class="flex min-h-0 flex-col gap-4 lg:flex-row">
    <!-- counters -->
    <div class="flex shrink-0 flex-col gap-1 lg:w-52">
      <div class="font-mono text-2xl text-foreground">
        {fmt(hintedCounter.value)} <span class="text-sm text-muted-foreground">routed</span>
      </div>
      <div class="font-mono text-xs text-muted-foreground">of {fmt(total)} prompts scored</div>
      <div class="mt-2 font-mono text-xs text-muted-foreground">
        standard <span class="text-foreground">{fmt(standard)}</span>
        <span class="mx-1">·</span>
        complex <span class={complex > 0 ? "text-[var(--c-opus)]" : "text-foreground"}>{fmt(complex)}</span>
      </div>
      {#if shadow}
        <div
          class="font-mono text-xs text-muted-foreground"
          title="Injection is off by default since v0.21 — Synthra records what it would have recommended so precision can be graded without spending your context. Set SYN_ROUTE_HINTS=1 to let it speak again."
        >
          shadow: would have hinted <span class="text-foreground">{fmt(matched)}</span>
        </div>
      {/if}
      <div
        class="font-mono text-xs text-muted-foreground"
        title="Hints followed by an actual subagent delegation within 30 minutes (exact = delegated to the recommended agent). Needs the v0.20 hooks — rerun syn ."
      >
        followed <span class={followed > 0 ? "text-[var(--c-fable)]" : "text-foreground"}>{fmt(followed)}</span>
        of {fmt(hinted)} hints
        {#if followedAgent > 0}<span class="text-muted-foreground/70">({fmt(followedAgent)} exact)</span>{/if}
      </div>
    </div>

    <!-- top agents -->
    <div class="flex shrink-0 flex-col gap-1.5 lg:w-64 lg:border-l lg:border-border lg:pl-4">
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Top routed agents</div>
      {#each topAgents as [name, count] (name)}
        <div class="flex items-baseline justify-between gap-2 font-mono text-xs">
          <span class="truncate text-foreground/80" title={name}>{name}</span>
          <span class="tabular-nums text-foreground">{count}</span>
        </div>
      {:else}
        <div class="text-sm text-muted-foreground">None yet — counted as hints fire.</div>
      {/each}
    </div>

    <!-- recent decisions -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-1 lg:border-l lg:border-border lg:pl-4">
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Recent decisions</div>
      <div class="flex max-h-[150px] min-h-0 flex-col gap-1 overflow-y-auto">
        {#each routes as r (r.ts + r.prompt)}
          <div class="flex items-baseline gap-2 font-mono text-xs">
            <span class="shrink-0 text-muted-foreground">{fmtTs(r.ts)}</span>
            <span
              class={"shrink-0 rounded px-1 text-[10px] uppercase " +
                (r.difficulty === "complex"
                  ? "bg-[var(--c-opus)]/15 text-[var(--c-opus)]"
                  : "bg-muted text-muted-foreground")}
            >{r.difficulty}</span>
            <span class="truncate text-foreground/80" title={r.prompt}>{r.prompt}</span>
            {#if r.agent}
              <span class="ml-auto shrink-0 text-[var(--c-fable)]" title={r.model ? `model: ${r.model}` : ""}
                >→ {r.agent}</span>
            {:else if !r.routed}
              <span class="ml-auto shrink-0 text-muted-foreground/60">silent</span>
            {/if}
          </div>
        {:else}
          <div class="text-sm text-muted-foreground">
            No routing decisions yet — the Dispatcher hints as you prompt.
          </div>
        {/each}
      </div>
    </div>
  </div>
</Card>
