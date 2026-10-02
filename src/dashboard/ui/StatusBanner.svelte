<script lang="ts">
  import { store } from "$lib/store.svelte";

  const s = $derived.by(() => {
    const health = store.overview?.health ?? [];
    const bad = health.filter((h) => h.problem);
    const fixable = bad.filter((h) => h.fix === "hooks");
    const waiting = health.filter((h) => h.note);
    return { total: health.length, bad, first: bad[0], fixable, waiting };
  });
</script>

<div class="flex items-center gap-4 rounded-xl border border-border bg-card/70 px-5 py-4">
  <div class="min-w-0 flex-1">
    {#if s.total === 0}
      <div class="font-serif text-[26px] leading-tight">No project has run Synthra yet.</div>
      <p class="mt-0.5 text-muted-foreground">Open a project in your editor with the Synthra extension, or run <code class="font-mono">syn .</code> in it.</p>
    {:else if !s.first && s.waiting.length > 0}
      <div class="font-serif text-[26px] leading-tight">
        Hooks fixed in {s.waiting.length === 1 ? (s.waiting[0]?.name ?? "1 project") : `${s.waiting.length} projects`}.
        <span class="italic text-muted-foreground">Waiting for a reply to confirm.</span>
      </div>
      <p class="mt-0.5 text-muted-foreground">Chat with Claude there as usual. The next reply shows here.</p>
    {:else if !s.first}
      <div class="font-serif text-[26px] leading-tight">
        Synthra works in {s.total === 1 ? "your project" : `all ${s.total} projects`}.
      </div>
      <p class="mt-0.5 text-muted-foreground">Every part of it ran as expected.</p>
    {:else}
      <div class="font-serif text-[26px] leading-tight">
        Synthra works in {s.total - s.bad.length} of {s.total} projects.
        <span class="italic text-sonnet">{s.bad.length === 1 ? `${s.first.name} needs a look.` : `${s.bad.length} need a look.`}</span>
      </div>
      <p class="mt-0.5 text-muted-foreground">{s.first.problem}</p>
    {/if}
  </div>
  {#if s.fixable.length > 0}
    <button
      onclick={() => store.fixHooks(s.fixable.map((h) => h.path))}
      disabled={store.fixing !== null}
      class="whitespace-nowrap rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground disabled:opacity-60"
    >
      {store.fixing !== null
        ? "Fixing…"
        : s.fixable.length === 1
          ? `Fix hooks for ${s.fixable[0]?.name}`
          : `Fix hooks in all ${s.fixable.length}`}
    </button>
  {/if}
</div>
