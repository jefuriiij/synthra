<script lang="ts">
  import { fmt } from "$lib/format";
  import type { Finding } from "$lib/types";

  let { finding: f }: { finding: Finding | undefined } = $props();

  const total = $derived(f ? f.map + f.files + f.search : 0);
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const kinds = [
    { key: "map" as const, label: "Synthra map", hint: "one function at a time", color: "var(--money)" },
    { key: "files" as const, label: "Whole files", hint: "Read, cat", color: "var(--ring)" },
    { key: "search" as const, label: "Search", hint: "grep, rg, Grep, Glob", color: "#ff8a5b" },
  ];
  const weekLabel = (iso: string, last: boolean) =>
    last ? "This week" : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
</script>

<div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{fmt(total)} lookups</div>
{#if f && total > 0}
  <div class="my-3 flex h-[34px] gap-[3px] overflow-hidden rounded-lg" role="img" aria-label={kinds.map((k) => `${k.label} ${pct(f[k.key])}%`).join(", ")}>
    {#each kinds as k (k.key)}
      {#if f[k.key] > 0}
        <div class="grid min-w-[3px] place-items-center font-mono text-[13px] font-medium text-background" style={`flex:${f[k.key]};background:${k.color}`}>
          {pct(f[k.key]) >= 5 ? `${pct(f[k.key])}%` : ""}
        </div>
      {/if}
    {/each}
  </div>
{:else}
  <p class="my-3 text-sm text-muted-foreground">No lookups were logged in this window yet.</p>
{/if}
<div class="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
  {#each kinds as k (k.key)}
    <span><i class="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]" style={`background:${k.color}`}></i><b class="font-medium text-foreground">{k.label}</b> · {k.hint}</span>
  {/each}
</div>
<div class="mt-5 flex h-[132px] items-end gap-3">
  {#each f?.weeks ?? [] as w, i (w.start)}
    {@const n = w.map + w.files + w.search}
    <div class="flex flex-1 flex-col gap-1.5">
      <div class="flex h-28 flex-col-reverse gap-[2px] overflow-hidden rounded-md bg-secondary/40">
        {#if n > 0}
          {#each kinds as k (k.key)}<div style={`flex:${w[k.key]};background:${k.color}`}></div>{/each}
        {/if}
      </div>
      <span class="text-center font-mono text-[11px] text-muted-foreground/70">{weekLabel(w.start, i === 3)}</span>
    </div>
  {/each}
</div>
{#if f && !f.reads_counted}
  <p class="mt-2 text-xs text-muted-foreground/70">Whole-file reads with the Read tool count from Synthra 0.34 on.</p>
{/if}
