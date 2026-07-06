<script lang="ts">
  import { PieChart, Text, Tooltip } from "layerchart";
  import Card from "$lib/components/Card.svelte";
  import { store } from "$lib/store.svelte";
  import { modelFamily, type ModelFamily } from "$lib/format";

  const FAMILIES: { fam: ModelFamily; label: string; color: string }[] = [
    { fam: "fable", label: "Fable", color: "var(--c-fable)" },
    { fam: "opus", label: "Opus", color: "var(--c-opus)" },
    { fam: "sonnet", label: "Sonnet", color: "var(--c-sonnet)" },
    { fam: "haiku", label: "Haiku", color: "var(--c-haiku)" },
    { fam: "unknown", label: "Other", color: "var(--c-unknown)" },
  ];

  const view = $derived.by(() => {
    const counts: Record<ModelFamily, number> = { fable: 0, opus: 0, sonnet: 0, haiku: 0, unknown: 0 };
    for (const p of store.data?.projects ?? [])
      for (const [model, n] of Object.entries(p.models ?? {})) counts[modelFamily(model)] += n;
    const total = FAMILIES.reduce((sum, f) => sum + counts[f.fam], 0);
    const arcs = FAMILIES.filter((f) => counts[f.fam] > 0).map((f) => ({
      ...f,
      n: counts[f.fam],
      pct: total > 0 ? Math.round((counts[f.fam] / total) * 100) : 0,
    }));
    return { arcs, total };
  });
</script>

<Card title="Model usage" meta="by turns">
  <div class="flex items-center gap-4">
    {#if view.total > 0}
      <div class="size-[130px] shrink-0">
        <PieChart
          data={view.arcs}
          key="fam"
          label="label"
          value="n"
          c="color"
          innerRadius={-14}
          cornerRadius={2}
          padAngle={0.02}
          props={{ pie: { motion: "tween" } }}
        >
          {#snippet aboveMarks()}
            <Text
              value={String(view.total)}
              textAnchor="middle"
              verticalAnchor="middle"
              class="fill-foreground font-mono text-2xl!"
              dy={2}
            />
            <Text
              value="TURNS"
              textAnchor="middle"
              verticalAnchor="middle"
              class="fill-muted-foreground font-mono text-[9px]! tracking-[0.14em]"
              dy={18}
            />
          {/snippet}
          {#snippet tooltip({ context })}
            <Tooltip.Root
              {context}
              class="rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs shadow-xl"
            >
              {#snippet children({ data })}
                <div class="flex items-center gap-2">
                  <span class="size-2 shrink-0 rounded-sm" style={`background:${data.color}`}></span>
                  <span class="text-muted-foreground">{data.label}</span>
                  <span class="ml-1 tabular-nums text-foreground">{data.n}</span>
                </div>
              {/snippet}
            </Tooltip.Root>
          {/snippet}
        </PieChart>
      </div>
    {/if}
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      {#each view.arcs as s (s.fam)}
        <div class="flex items-center gap-2 font-mono text-sm">
          <span class="size-2 rounded-sm" style={`background:${s.color}`}></span>
          <span class="flex-1 text-muted-foreground">{s.label}</span>
          <span class="tabular-nums text-foreground">{s.n}</span>
          <span class="w-9 text-right tabular-nums text-muted-foreground">{s.pct}%</span>
        </div>
      {:else}
        <div class="text-sm text-muted-foreground">No turns yet — model usage lands here after your first Claude turn.</div>
      {/each}
    </div>
  </div>
</Card>
