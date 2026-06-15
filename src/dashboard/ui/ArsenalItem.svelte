<script lang="ts">
  import type { ArsenalItem } from "$lib/types";
  let { item }: { item: ArsenalItem } = $props();
  let open = $state(false);

  const badge = $derived(item.scope === "plugin" ? (item.source ?? "plugin") : item.scope);
  const color = $derived(
    item.scope === "project"
      ? "var(--c-fable)"
      : item.scope === "personal"
        ? "var(--c-sonnet)"
        : "#9bc2ef",
  );
  const meta = $derived(Object.entries(item.meta ?? {}));
</script>

<button
  onclick={() => (open = !open)}
  class="flex flex-col gap-1.5 rounded-lg border bg-card/55 p-3 text-left transition-colors hover:bg-card/85"
>
  <div class="flex items-center gap-2">
    <span class="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{item.name}</span>
    <span
      class="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide"
      style={`color:${color}; border-color:color-mix(in oklab, ${color} 35%, transparent)`}
      class:opacity-50={item.enabled === false}
    >
      {badge}{item.enabled === false ? " · off" : ""}
    </span>
  </div>
  {#if item.description}
    <p class={"text-sm leading-snug text-muted-foreground " + (open ? "" : "line-clamp-2")}>
      {item.description}
    </p>
  {/if}
  {#if open && meta.length}
    <div class="mt-1 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground/80">
      {#each meta as [k, v] (k)}
        <div class="break-all"><span class="text-foreground/70">{k}:</span> {v}</div>
      {/each}
    </div>
  {/if}
</button>
