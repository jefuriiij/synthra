<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { CountUp } from "$lib/countup";
  import { store } from "$lib/store.svelte";
  import { fmt, fmtCost } from "$lib/format";

  const c = $derived.by(() => {
    const g = store.data?.global;
    const turns = g?.total_turns ?? 0;
    const cost = g?.estimated_cost_usd ?? 0;
    return {
      cost,
      tokens: (g?.total_input_tokens ?? 0) + (g?.total_output_tokens ?? 0),
      avg: turns > 0 ? cost / turns : 0,
    };
  });

  const costCounter = new CountUp();
  $effect(() => costCounter.set(c.cost));
</script>

<Card title="Total spend" meta="all time">
  <div class="font-mono text-3xl text-[var(--money)]">{fmtCost(costCounter.value)}</div>
  <div class="mt-1 flex flex-col gap-1 font-mono text-sm text-muted-foreground">
    <div class="flex justify-between"><span>Tokens (in+out)</span><span class="text-foreground">{fmt(c.tokens)}</span></div>
    <div class="flex justify-between"><span>Avg / turn</span><span class="text-foreground">{fmtCost(c.avg)}</span></div>
  </div>
</Card>
