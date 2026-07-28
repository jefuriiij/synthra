<script lang="ts">
  import { Dialog } from "bits-ui";
  import Card from "$lib/components/Card.svelte";
  import { store } from "$lib/store.svelte";
  import { fmt, fmtCost, fmtTs, projColor } from "$lib/format";
  import type { ProjectStats } from "$lib/types";

  let open = $state(false);
  let sel = $state<ProjectStats | null>(null);

  const projects = $derived(store.data?.projects ?? []);
  const maxTurns = $derived(Math.max(1, ...projects.map((p) => p.total_turns)));

  function lastActive(p: ProjectStats): string {
    const t = (store.data?.recent_turns ?? []).find((x) => x.project_path === p.path);
    if (t) return fmtTs(t.ts);
    return p.last_seen ? fmtTs(p.last_seen) : "—";
  }
  function cells(p: ProjectStats): [string, string][] {
    return [
      ["Cost", fmtCost(p.estimated_cost_usd)],
      ["Turns", fmt(p.total_turns)],
      ["Input", fmt(p.total_input_tokens)],
      ["Output", fmt(p.total_output_tokens)],
      ["Cache R", fmt(p.total_cache_read)],
      ["Cache W", fmt(p.total_cache_create)],
      ["Blocks", fmt(p.blocked_count)],
      ["Last active", lastActive(p)],
    ];
  }
</script>

<Card title="Projects" meta="by turns" class="syn-card-projects">
  <div class="flex max-h-[260px] flex-col gap-2 overflow-y-auto pr-1">
    {#each projects as p (p.path)}
      <button onclick={() => { sel = p; open = true; }} class="flex flex-col gap-1 text-left">
        <div class="flex items-center gap-2 font-mono text-sm">
          <span class="size-2 shrink-0 rounded-sm" style={`background:${projColor(p.name)}`}></span>
          <span class="flex-1 truncate text-foreground">{p.name}</span>
          <span class="tabular-nums text-muted-foreground">{fmt(p.total_turns)}</span>
        </div>
        <div class="h-1 overflow-hidden rounded-full bg-border">
          <div class="h-full" style={`width:${(p.total_turns / maxTurns) * 100}%; background:${projColor(p.name)}`}></div>
        </div>
      </button>
    {:else}
      <div class="text-sm text-muted-foreground">No projects tracked yet — run <code class="text-foreground">syn .</code></div>
    {/each}
  </div>
</Card>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/60" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-5 text-card-foreground shadow-2xl"
    >
      {#if sel}
        <Dialog.Title class="font-serif text-xl" style={`color:${projColor(sel.name)}`}>{sel.name}</Dialog.Title>
        <Dialog.Description class="truncate font-mono text-xs text-muted-foreground">{sel.path}</Dialog.Description>
        <div class="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border">
          {#each cells(sel) as [k, v] (k)}
            <div class="flex flex-col gap-0.5 bg-card p-3">
              <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{k}</span>
              <span class="font-mono text-sm text-foreground">{v}</span>
            </div>
          {/each}
        </div>
        <Dialog.Close class="mt-4 w-full rounded-md border py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
          Close
        </Dialog.Close>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
