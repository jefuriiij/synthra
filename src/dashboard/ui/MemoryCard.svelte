<script lang="ts">
  import { store } from "$lib/store.svelte";
  import { fmtAgo } from "$lib/format";
  import type { KnowledgeCard } from "$lib/types";

  const m = $derived(store.overview?.memory ?? null);
  const files = $derived(
    m
      ? ([
          ["MEMORY.md", store.overview?.project.name ?? "this project", m.project],
          ["USER.md", "you", m.user],
        ] as [string, string, KnowledgeCard][])
      : [],
  );
  const full = (k: KnowledgeCard) => (k.limit > 0 ? k.chars / k.limit : 0);
</script>

<div class="h-full rounded-xl border border-border bg-card/70 px-5 py-4">
  {#if !m}
    <p class="text-sm text-muted-foreground">Memory could not be read.</p>
  {:else}
    {#each files as [file, who, k] (file)}
      <div class="mb-4">
        <div class="flex justify-between text-[13.5px]">
          <code class="font-mono text-[13px]">{file}</code>
          <span class="font-mono text-[12.5px] text-muted-foreground">{who} · {k.chars.toLocaleString("en-US")} / {k.limit.toLocaleString("en-US")}</span>
        </div>
        <div class="my-1.5 h-2.5 overflow-hidden rounded-full bg-secondary/60">
          <div class={"h-full rounded-full " + (full(k) >= 0.9 ? "bg-sonnet" : "bg-money")} style={`width:${Math.min(100, full(k) * 100)}%`}></div>
        </div>
        {#if !k.exists}
          <div class="text-[12.5px] text-muted-foreground/70">Not written yet.</div>
        {:else if full(k) >= 0.9}
          <div class="text-[12.5px] text-sonnet">Almost full. Claude will have to replace old notes to add new ones.</div>
        {:else}
          <div class="text-[12.5px] text-muted-foreground/70">{k.entries} entries · changed {fmtAgo(k.changed_at)}</div>
        {/if}
      </div>
    {/each}

    <div class="flex gap-2.5">
      <div class="flex-1 rounded-lg border border-border bg-secondary/50 p-3">
        <div class="font-mono text-2xl font-medium">{m.notes}</div>
        <div class="text-[12.5px] text-muted-foreground">session notes</div>
      </div>
      <div class={"flex-1 rounded-lg border bg-secondary/50 p-3 " + (m.stale_notes > 0 ? "border-sonnet/40" : "border-border")}>
        <div class={"font-mono text-2xl font-medium " + (m.stale_notes > 0 ? "text-sonnet" : "")}>{m.stale_notes}</div>
        <div class="text-[12.5px] text-muted-foreground">out of date (their file changed)</div>
      </div>
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-dashed border-border pt-3.5 text-[13px]">
      <span class="rounded-lg border border-border bg-secondary/50 px-2.5 py-1"><b class="mr-1 font-mono">{m.reminders}</b>reminders</span>
      <span class="text-muted-foreground/60">→</span>
      <span class="rounded-lg border border-border bg-secondary/50 px-2.5 py-1"><b class="mr-1 font-mono">{m.saves}</b>memory saves</span>
    </div>
  {/if}
</div>
