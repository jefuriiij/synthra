<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { store } from "$lib/store.svelte";
  import { fmt, fmtCost } from "$lib/format";

  const s = $derived.by(() => {
    const g = store.data?.global;
    const blocks = g?.blocked_count ?? 0;
    const money = (blocks * 500 * 3) / 1_000_000; // floor: blocks × 500 tok × $3/M
    const paid = g?.estimated_cost_usd ?? 0;
    const baseline = paid + money;
    const pct = baseline > 0 ? (money / baseline) * 100 : 0;
    return {
      blocks,
      money,
      paid,
      baseline,
      pct,
      tokens: g?.estimated_tokens_saved ?? 0,
      paidWidth: baseline > 0 ? (paid / baseline) * 100 : 100,
    };
  });
</script>

<Card title="Synthra savings" meta={`${s.pct.toFixed(1)}% off · floor`}>
  <div class="flex flex-col gap-3">
    <div>
      <div class="font-mono text-3xl text-[var(--money)]">{fmtCost(s.money)}</div>
      <div class="font-mono text-sm text-muted-foreground">{fmt(s.tokens)} tokens avoided</div>
    </div>
    <div class="flex h-2 overflow-hidden rounded-full bg-border">
      <div class="h-full bg-muted-foreground/40" style={`width:${s.paidWidth}%`}></div>
      <div class="h-full bg-[var(--money)]" style={`width:${100 - s.paidWidth}%`}></div>
    </div>
    <div class="flex justify-between font-mono text-xs text-muted-foreground">
      <span>you paid <b class="text-foreground">{fmtCost(s.paid)}</b></span>
      <span>baseline <b class="text-foreground">{fmtCost(s.baseline)}</b></span>
    </div>
    <div class="rounded-md border border-dashed border-border px-3 py-2 text-center font-mono text-xs text-muted-foreground">
      <b class="text-foreground">{s.blocks}</b> blocks × <b class="text-foreground">500</b> tokens × <b class="text-foreground">$3</b>/M = <b class="text-[var(--money)]">{fmtCost(s.money)}</b>
    </div>
  </div>
</Card>
