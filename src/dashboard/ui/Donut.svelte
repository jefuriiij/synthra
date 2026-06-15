<script lang="ts">
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
  const C = 2 * Math.PI * 52;

  const view = $derived.by(() => {
    const counts: Record<ModelFamily, number> = { fable: 0, opus: 0, sonnet: 0, haiku: 0, unknown: 0 };
    for (const p of store.data?.projects ?? [])
      for (const [model, n] of Object.entries(p.models ?? {})) counts[modelFamily(model)] += n;
    const total = FAMILIES.reduce((sum, f) => sum + counts[f.fam], 0);
    let offset = 0;
    const arcs = FAMILIES.filter((f) => counts[f.fam] > 0).map((f) => {
      const n = counts[f.fam];
      const len = total > 0 ? (n / total) * C : 0;
      const seg = { ...f, n, len, offset, pct: total > 0 ? Math.round((n / total) * 100) : 0 };
      offset += len;
      return seg;
    });
    return { arcs, total };
  });
</script>

<Card title="Model usage" meta="by turns">
  <div class="flex items-center gap-4">
    <div class="relative size-[116px] shrink-0">
      <svg viewBox="0 0 140 140" class="size-full -rotate-90">
        <circle cx="70" cy="70" r="52" fill="none" stroke="var(--border)" stroke-width="14" />
        {#each view.arcs as s (s.fam)}
          <circle
            cx="70" cy="70" r="52" fill="none" stroke={s.color} stroke-width="14"
            stroke-dasharray={`${s.len} ${C}`} stroke-dashoffset={-s.offset}
            stroke-linecap={view.arcs.length === 1 ? "round" : "butt"}
          />
        {/each}
      </svg>
      <div class="absolute inset-0 grid place-items-center">
        <div class="text-center">
          <div class="font-mono text-2xl text-foreground">{view.total}</div>
          <div class="font-mono text-[9px] uppercase text-muted-foreground">turns</div>
        </div>
      </div>
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      {#each view.arcs as s (s.fam)}
        <div class="flex items-center gap-2 font-mono text-[11px]">
          <span class="size-2 rounded-sm" style={`background:${s.color}`}></span>
          <span class="flex-1 text-muted-foreground">{s.label}</span>
          <span class="tabular-nums text-foreground">{s.n}</span>
          <span class="w-9 text-right tabular-nums text-muted-foreground">{s.pct}%</span>
        </div>
      {:else}
        <div class="text-[11px] text-muted-foreground">No turns yet.</div>
      {/each}
    </div>
  </div>
</Card>
