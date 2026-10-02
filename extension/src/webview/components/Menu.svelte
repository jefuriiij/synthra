<script lang="ts" module>
  import Icon, { type IconName } from "./Icon.svelte";

  // One menu open at a time, across every row.
  let closeOpen: (() => void) | null = null;

  export interface MenuItem {
    label: string;
    icon?: IconName;
    /** Shown right-aligned, muted. */
    hint?: string;
    /** A destructive action: red on hover. */
    danger?: boolean;
    /** A line above this item. */
    sep?: boolean;
    disabled?: boolean;
    run: () => void;
  }
</script>

<script lang="ts">
  // A "..." button that opens a small action menu, in VS Code's menu colours.
  // Keyboard: arrows, Home/End, Enter, Escape (focus goes back to the button).
  // Closes on a click outside, on scroll, and when another menu opens.
  import { tick } from "svelte";

  let { items, label }: { items: MenuItem[]; label: string } = $props();

  let open = $state(false);
  /** Fixed to the window, from the button's place: a card that clips its
   *  rows (overflow: hidden) can't cut the menu off. */
  let place = $state("");
  let trigger = $state<HTMLButtonElement>();
  let list = $state<HTMLDivElement>();

  const enabled = () =>
    [...(list?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];

  function close(focusBack = false): void {
    open = false;
    if (closeOpen === closeMe) closeOpen = null;
    if (focusBack) trigger?.focus();
  }
  const closeMe = () => close();

  async function show(): Promise<void> {
    closeOpen?.();
    closeOpen = closeMe;
    // Open upward when the row sits near the bottom of the window.
    const r = trigger?.getBoundingClientRect();
    if (r) {
      const up = window.innerHeight - r.bottom < 260 && r.top > 260;
      const right = Math.max(4, window.innerWidth - r.right);
      place = up
        ? `bottom:${window.innerHeight - r.top + 4}px;right:${right}px`
        : `top:${r.bottom + 4}px;right:${right}px`;
    }
    open = true;
    await tick();
    enabled()[0]?.focus();
  }

  function onKey(e: KeyboardEvent): void {
    const all = enabled();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = all.length;
      all[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? all[0] : all[all.length - 1])?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  }

  function pick(item: MenuItem): void {
    close(true);
    item.run();
  }

  $effect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list?.contains(t) && !trigger?.contains(t)) close();
    };
    const scrolled = () => close();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scrolled, true);
    };
  });
</script>

<span class="menu-wrap">
  <button
    type="button"
    class="icon-btn"
    class:on={open}
    bind:this={trigger}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={label}
    onclick={() => (open ? close() : void show())}
  >
    <Icon name="more" size={16} />
  </button>
  {#if open}
    <div class="menu" role="menu" tabindex="-1" style={place} bind:this={list} onkeydown={onKey}>
      {#each items as item (item.label)}
        {#if item.sep}<div class="sep" role="separator"></div>{/if}
        <button
          type="button"
          role="menuitem"
          class:danger={item.danger}
          disabled={item.disabled}
          onclick={() => pick(item)}
        >
          {#if item.icon}<Icon name={item.icon} size={14} />{/if}
          <span>{item.label}</span>
          {#if item.hint}<span class="hint">{item.hint}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</span>

<style>
  .menu-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .icon-btn.on {
    border-color: var(--input-border);
    background: var(--hover);
  }
  .menu {
    position: fixed;
    z-index: 20;
    min-width: 200px;
    padding: 4px;
    border: 1px solid var(--vscode-menu-border, var(--border));
    border-radius: 6px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--fg));
    box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .menu button:hover:not(:disabled),
  .menu button:focus-visible {
    outline: none;
    background: var(--vscode-menu-selectionBackground, var(--selected));
    color: var(--vscode-menu-selectionForeground, var(--selected-fg));
  }
  .menu button.danger:hover:not(:disabled),
  .menu button.danger:focus-visible {
    background: var(--vscode-inputValidation-errorBackground, #c72e2e);
    color: var(--vscode-menu-selectionForeground, #fff);
  }
  .menu button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hint {
    margin-left: auto;
    padding-left: 12px;
    font-size: 11px;
    opacity: 0.7;
  }
  .sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--vscode-menu-separatorBackground, var(--border));
  }
</style>
