<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import type { ArsenalItem } from "$lib/types";
  let { item }: { item: ArsenalItem } = $props();
  let open = $state(false);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const badge = $derived(item.scope === "plugin" ? (item.source ?? "plugin") : item.scope);
  const color = $derived(
    item.scope === "project"
      ? "var(--c-fable)"
      : item.scope === "personal"
        ? "var(--c-sonnet)"
        : "#9bc2ef",
  );
  const meta = $derived(Object.entries(item.meta ?? {}));

  function toggle() {
    open = !open;
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  }
  async function copyName(e: MouseEvent) {
    e.stopPropagation(); // don't toggle the card
    try {
      await navigator.clipboard.writeText(item.name);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  }
</script>

<!-- The card is a div-with-button-semantics (not a <button>) so the copy
     control can be a real nested button — buttons can't contain buttons. -->
<div
  role="button"
  tabindex="0"
  onclick={toggle}
  onkeydown={onKeydown}
  class="flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-card/55 p-3 text-left transition-colors hover:bg-card/85"
>
  <div class="flex items-center gap-1.5">
    <span class="min-w-0 truncate font-mono text-sm text-foreground">{item.name}</span>
    <button
      type="button"
      onclick={copyName}
      title="Copy name"
      aria-label={`Copy "${item.name}"`}
      class="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
    >
      {#if copied}
        <Check class="size-3.5" style="color: var(--c-fable)" />
      {:else}
        <Copy class="size-3.5" />
      {/if}
    </button>
    <span
      class="ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide"
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
</div>
