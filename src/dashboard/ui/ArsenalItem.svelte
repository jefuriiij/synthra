<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import Heart from "@lucide/svelte/icons/heart";
  import { itemBadge, itemKind, scopeColor } from "$lib/arsenal-groups";
  import type { ArsenalItem } from "$lib/types";
  // showBadge: redundant once a specific group is selected in the left panel —
  // every card there shares the same scope/plugin/pack.
  //
  // onToggleFavorite absent = no heart. That's how the MCP tab opts out: it
  // simply doesn't pass a handler, so there's no per-kind branch in here.
  let {
    item,
    showBadge = true,
    favorite = false,
    onOpen,
    onToggleFavorite,
  }: {
    item: ArsenalItem;
    showBadge?: boolean;
    favorite?: boolean;
    onOpen: (item: ArsenalItem) => void;
    onToggleFavorite?: (item: ArsenalItem) => void;
  } = $props();
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const badge = $derived(itemBadge(item));
  const color = $derived(scopeColor(itemKind(item)));

  function onKeydown(e: KeyboardEvent) {
    // Enter on the nested copy button must copy, not also open the modal.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(item);
    }
  }
  async function copyName(e: MouseEvent) {
    e.stopPropagation(); // don't open the detail modal
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
  aria-haspopup="dialog"
  onclick={() => onOpen(item)}
  onkeydown={onKeydown}
  class="syn-arsenal-card flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-card/55 p-3 text-left transition-colors hover:bg-card/85"
>
  <div class="syn-arsenal-card-head flex items-center gap-1.5">
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
    {#if onToggleFavorite}
      <!-- Before the badge, not after: the badge is conditional, so a heart to
           its right would sit at a different x on every card. -->
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation(); // don't open the detail modal
          onToggleFavorite?.(item);
        }}
        aria-pressed={favorite}
        aria-label={`Favorite "${item.name}"`}
        title={favorite ? "Unfavorite" : "Favorite"}
        class="syn-arsenal-card-fav inline-flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent"
        class:text-muted-foreground={!favorite}
        class:opacity-60={!favorite}
      >
        <Heart
          class="size-3.5"
          fill={favorite ? "currentColor" : "none"}
          style={favorite ? "color: var(--c-opus)" : undefined}
        />
      </button>
    {/if}
    {#if showBadge || item.enabled === false}
      <span
        class="syn-arsenal-card-badge ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide"
        style={`color:${color}; border-color:color-mix(in oklab, ${color} 35%, transparent)`}
        class:opacity-50={item.enabled === false}
      >
        {showBadge ? badge : "off"}{showBadge && item.enabled === false ? " · off" : ""}
      </span>
    {/if}
  </div>
  {#if item.description}
    <!-- Always clamped: the full text lives in the modal, and uniform card
         heights are the point of a browsable grid. -->
    <p class="line-clamp-2 text-sm leading-snug text-muted-foreground">
      {item.description}
    </p>
  {/if}
</div>
