<script lang="ts">
  import { fmt } from "$lib/format";
  import type { Finding } from "$lib/types";

  let { finding: f }: { finding: Finding | undefined } = $props();
</script>

<div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Missed chances</div>
<div class="mt-2 font-mono text-[34px] font-medium leading-none">
  {fmt(f?.missed ?? 0)}<small class="ml-1.5 font-sans text-[13px] font-normal text-muted-foreground">of {fmt(f?.terminal ?? 0)} terminal commands</small>
</div>
<div class="mt-1 text-[13px] text-muted-foreground">asked for code the map already knew.</div>
{#if f && f.missed_examples.length > 0}
  <div class="mt-3 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1.5 font-mono text-[12.5px]">
    {#each f.missed_examples as m, i (i)}
      <span class="rounded bg-[#ff8a5b]/15 px-1.5 text-[#ff8a5b]">{m.tool}</span>
      <span class="truncate text-muted-foreground" title={m.text}>{m.text}</span>
    {/each}
  </div>
  <div class="mt-3.5 border-t border-dashed border-border pt-3 text-[13px] text-muted-foreground">
    <b class="font-medium text-foreground">Idea:</b> Synthra watches terminal searches but never stops them. Answering searches like these from the map would raise the map share.
  </div>
{:else}
  <p class="mt-3 text-[13px] text-muted-foreground">None in this window.</p>
{/if}
