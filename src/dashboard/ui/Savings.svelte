<script lang="ts">
  import Card from "$lib/components/Card.svelte";
  import { CountUp } from "$lib/countup";
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

  const moneyCounter = new CountUp();
  $effect(() => moneyCounter.set(s.money));
</script>

<Card title="Saved by Synthra" meta="estimate" class="syn-card-savings">
  <div class="flex flex-col gap-3">
    <div>
      <div class="font-mono text-3xl text-[var(--money)]">{fmtCost(moneyCounter.value)}</div>
      <div class="text-sm text-muted-foreground">
        {fmt(s.blocks)} repeat searches stopped · {fmt(s.tokens)} tokens · {s.pct.toFixed(1)}% less
      </div>
    </div>
    <div class="flex h-2 overflow-hidden rounded-full bg-border">
      <div class="h-full bg-muted-foreground/40" style={`width:${s.paidWidth}%`}></div>
      <div class="h-full bg-[var(--money)]" style={`width:${100 - s.paidWidth}%`}></div>
    </div>
    <div class="flex justify-between font-mono text-xs text-muted-foreground">
      <span>you paid <b class="text-foreground">{fmtCost(s.paid)}</b></span>
      <span>without Synthra <b class="text-foreground">{fmtCost(s.baseline)}</b></span>
    </div>
    <div class="text-xs text-muted-foreground">
      Each stopped search counts as 500 tokens at $3 per million, so the real saving is usually higher.
    </div>
  </div>
</Card>
