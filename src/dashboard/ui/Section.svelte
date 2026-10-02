<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, sub, why, children }: { title: string; sub?: string; why?: string; children?: Snippet } = $props();
</script>

<section class="flex flex-col">
  <h2 class="mt-8 flex items-baseline gap-2.5 font-serif text-[25px] font-normal text-foreground">
    {title}
    {#if sub}<small class="font-sans text-[13px] text-muted-foreground">{sub}</small>{/if}
  </h2>
  {#if why}<p class="mb-3.5 mt-1 text-[13px] text-muted-foreground/70">{why}</p>{/if}
  {@render children?.()}
</section>
