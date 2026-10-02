<script lang="ts">
  import { store } from "$lib/store.svelte";

  const l = $derived(store.overview?.learning ?? null);
  const top = $derived(Math.max(1, ...(l?.most_used ?? []).map((s) => s.uses)));
  const tiles = $derived(
    l
      ? [
          { n: l.live, label: "live", attn: false },
          { n: l.waiting, label: "waiting for you", attn: l.waiting > 0 },
          { n: l.stale, label: "stale", attn: false },
          { n: l.archived, label: "archived", attn: false },
        ]
      : [],
  );
</script>

<div class="h-full rounded-xl border border-border bg-card/70 px-5 py-4">
  {#if !l}
    <p class="text-sm text-muted-foreground">Skills could not be read.</p>
  {:else}
    <div class="mb-4 grid grid-cols-4 gap-2.5">
      {#each tiles as t (t.label)}
        <div class={"rounded-lg border bg-secondary/50 p-3 " + (t.attn ? "border-sonnet/40" : "border-border")}>
          <div class={"font-mono text-2xl font-medium " + (t.attn ? "text-sonnet" : "")}>{t.n}</div>
          <div class="text-[12.5px] text-muted-foreground">{t.label}</div>
        </div>
      {/each}
    </div>

    <div class="mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Used most</div>
    {#if l.most_used.length > 0}
      <div class="grid gap-2.5">
        {#each l.most_used as s (s.name + s.scope)}
          <div class="grid grid-cols-[1fr_44px] items-center gap-2.5 text-[13.5px]">
            <div>
              {s.name}<span class="ml-1.5 font-mono text-[11.5px] text-muted-foreground/70">{s.scope}</span>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary/60">
                <div class="h-full rounded-full bg-money" style={`width:${(s.uses / top) * 100}%`}></div>
              </div>
            </div>
            <span class="text-right font-mono text-[13px] text-muted-foreground">{s.uses}×</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="text-[13px] text-muted-foreground">No skill Synthra wrote has been used yet.</p>
    {/if}

    {#if l.never_used.length > 0}
      <div class="mt-3.5 text-[13px] text-muted-foreground">
        Never used since written:
        <div class="mt-1 flex flex-wrap gap-1">
          {#each l.never_used as n (n)}<code class="rounded-md border border-border bg-secondary/50 px-1.5 py-0.5 font-mono text-xs text-foreground">{n}</code>{/each}
        </div>
      </div>
    {/if}

    <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-dashed border-border pt-3.5 text-[13px]">
      <span class="rounded-lg border border-border bg-secondary/50 px-2.5 py-1"><b class="mr-1 font-mono">{l.reminders}</b>reminders</span>
      <span class="text-muted-foreground/60">→</span>
      <span class="rounded-lg border border-border bg-secondary/50 px-2.5 py-1"><b class="mr-1 font-mono">{l.proposed}</b>skills written</span>
      <span class="text-muted-foreground/60">→</span>
      <span class="rounded-lg border border-border bg-secondary/50 px-2.5 py-1"><b class="mr-1 font-mono">{l.kept}</b>kept</span>
    </div>
  {/if}
</div>
