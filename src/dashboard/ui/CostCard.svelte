<script lang="ts">
  import { store } from "$lib/store.svelte";
  import { CountUp } from "$lib/countup";
  import { fmt, fmtCost, fmtTs, modelLabel } from "$lib/format";

  const c = $derived(store.overview?.cost);
  const change = $derived(
    c && c.spend > 0 && c.previous > 0 ? Math.round(((c.spend - c.previous) / c.previous) * 100) : null,
  );
  const models = [
    { key: "opus", label: "Opus", color: "var(--c-opus)" },
    { key: "sonnet", label: "Sonnet", color: "var(--c-sonnet)" },
    { key: "fable", label: "Fable", color: "var(--c-fable)" },
    { key: "haiku", label: "Haiku", color: "var(--c-haiku)" },
    { key: "other", label: "Other", color: "var(--c-unknown)" },
  ];
  const share = (k: string) => (c && c.spend > 0 ? Math.round(((c.models[k] ?? 0) / c.spend) * 100) : 0);
  const spend = new CountUp();
  $effect(() => spend.set(c?.spend ?? 0));
  const windowWord = $derived(store.days === 30 ? "month" : "week");
</script>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
  <div class="rounded-xl border border-border bg-card/70 px-5 py-4">
    <div class="flex flex-wrap items-baseline gap-3">
      <span class="font-mono text-[30px] font-medium text-money">{fmtCost(spend.value)}</span>
      <span class="text-muted-foreground">
        this {windowWord} · {fmt(c?.replies ?? 0)} replies
        {#if change !== null}· <span class={change > 0 ? "text-destructive" : "text-money"}>{change > 0 ? "+" : ""}{change}%</span> vs last {windowWord}{/if}
      </span>
    </div>
    {#if c && c.spend > 0}
      <div class="my-3 flex h-2 gap-[2px] overflow-hidden rounded-full">
        {#each models as m (m.key)}
          {#if (c.models[m.key] ?? 0) > 0}<div style={`flex:${c.models[m.key]};background:${m.color}`}></div>{/if}
        {/each}
      </div>
      <div class="flex flex-wrap gap-4 text-[13px] text-muted-foreground">
        {#each models.filter((m) => (c?.models[m.key] ?? 0) > 0) as m (m.key)}
          <span><i class="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]" style={`background:${m.color}`}></i>{m.label} {share(m.key)}%</span>
        {/each}
      </div>
    {:else}
      <p class="my-3 text-sm text-muted-foreground">No replies were logged this {windowWord}.</p>
    {/if}
    <p class="mt-2 text-xs text-muted-foreground/70">On a Claude plan you pay the plan, not this. It shows what the work would cost on the API.</p>
  </div>

  <div class="rounded-xl border border-border bg-card/70 px-5 py-4">
    <div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Most expensive replies</div>
    {#each c?.priciest ?? [] as r, i (i)}
      <div class="grid grid-cols-[1fr_auto] border-t border-border py-2 text-[13.5px] first-of-type:mt-2">
        <span>{r.project}<small class="block font-mono text-xs text-muted-foreground/70">{fmtTs(r.ts)} · {modelLabel(r.model)}</small></span>
        <span class="font-mono text-[13px] text-money">{fmtCost(r.cost)}</span>
      </div>
    {:else}
      <p class="mt-2 text-[13px] text-muted-foreground">None this {windowWord}.</p>
    {/each}
  </div>
</div>
