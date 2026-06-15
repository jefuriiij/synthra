<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    title,
    meta,
    class: cls = "",
    children,
  }: { title?: string; meta?: string; class?: string; children?: Snippet } = $props();
</script>

<section class={"flex min-h-0 flex-col gap-3 rounded-xl border bg-card/55 p-4 transition-colors hover:bg-card/80 " + cls}>
  {#if title}
    <header class="flex items-baseline justify-between gap-3">
      <span class="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{title}</span>
      {#if meta}
        <span class="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{meta}</span>
      {/if}
    </header>
  {/if}
  {@render children?.()}
</section>
