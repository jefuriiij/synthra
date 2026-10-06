<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    title,
    sub,
    why,
    class: cls = "",
    children,
  }: { title?: string; sub?: string; why?: string; class?: string; children?: Snippet } = $props();
</script>

<!-- One card of the grid, with its question as the title. -->
<section class={"min-w-0 rounded-2xl border border-border bg-linear-to-b from-[#0c1a3a] to-card px-5 py-4.5 " + cls}>
  {#if title}
    <h2 class="flex flex-wrap items-baseline gap-x-2.5 font-serif text-[26px] font-normal leading-tight text-foreground">
      {title}
      {#if sub}<small class="font-sans text-[13px] text-muted-foreground">{sub}</small>{/if}
    </h2>
  {/if}
  {#if why}<p class="mb-4 mt-0.5 text-[13px] text-muted-foreground/80">{why}</p>{/if}
  {@render children?.()}
</section>
