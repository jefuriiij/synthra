<script lang="ts">
  import type { MemoryKind, MemoryNote, MemoryTab } from "../../shared/tabs";
  import { plural, relativeTime } from "../../shared/time";
  import { store } from "../lib/store.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

  let { memory, now }: { memory: MemoryTab; now: number } = $props();

  const ICON: Record<MemoryKind, IconName> = {
    task: "target",
    blocker: "blocker",
    next: "next",
    decision: "decision",
    fact: "fact",
    earlier: "history",
  };

  let query = $state("");
  const needle = $derived(query.trim().toLowerCase());
  const matches = (n: MemoryNote) =>
    !needle ||
    n.text.toLowerCase().includes(needle) ||
    n.tags.some((t) => t.toLowerCase().includes(needle)) ||
    n.files.some((f) => f.path.toLowerCase().includes(needle));

  const sections = $derived(
    memory.sections
      .map((s) => ({ ...s, notes: s.notes.filter(matches) }))
      .filter((s) => s.notes.length > 0),
  );

  /** Folded sections the user opened (Earlier tasks starts folded). */
  let opened = $state<Record<string, boolean>>({});
  const folded = (kind: MemoryKind, startsFolded: boolean) =>
    startsFolded && !opened[kind] && !needle;
</script>

<div class="hero">
  <Icon name="memory" size={26} class="syn" />
  <div class="stack">
    <span class="headline">
      {#if memory.unreadable}
        Synthra can't read this branch's memory
      {:else if memory.total === 0}
        Nothing remembered on {memory.branch || "this branch"} yet
      {:else}
        Synthra remembers {plural(memory.total, "note")} on {memory.branch || "this branch"}
      {/if}
    </span>
    <span class="small muted">
      {#if memory.unreadable}
        {memory.unreadable}
      {:else if memory.total === 0}
        Claude saves notes here with context_remember: decisions, tasks, next steps.
      {:else}
        {memory.stale ? `${memory.stale} may be out of date` : "All up to date"}
        {#if memory.contextMd}
          · <button type="button" class="link-btn" onclick={() => store.open(memory.contextMd)}>Open CONTEXT.md</button>
        {/if}
      {/if}
    </span>
  </div>
  {#if memory.store}
    <span class="spacer"></span>
    <button type="button" class="link-btn small" onclick={() => store.open(memory.store)}>Open the memory file</button>
  {/if}
</div>

{#if memory.total > 0}
  <div class="search">
    <Icon name="search" size={14} />
    <label for="memory-filter" class="sr-only">Filter notes</label>
    <input id="memory-filter" bind:value={query} type="text" placeholder="Filter {memory.total} notes by text, tag or file" />
  </div>
{/if}

{#if needle && sections.length === 0}
  <p class="empty">No notes match “{query.trim()}”.</p>
{/if}

{#each sections as s (s.kind)}
  <h2 class="section-label" title={s.hint}>
    <Icon name={ICON[s.kind]} size={13} />
    {s.label}
    <span class="aside">· {s.notes.length}</span>
  </h2>
  {#if folded(s.kind, s.folded)}
    <div class="card">
      <button type="button" class="row-btn small" onclick={() => (opened = { ...opened, [s.kind]: true })}>
        <Icon name="chevron" size={14} class="muted" />
        <span class="link">Show {plural(s.notes.length, "earlier task")}</span>
      </button>
    </div>
  {:else}
    <div class="card" class:current={s.kind === "task"}>
      {#each s.notes as n (n.id)}
        {@render note(n, s.kind)}
      {/each}
    </div>
  {/if}
{/each}

{#snippet note(n: MemoryNote, kind: MemoryKind)}
  <div class="row">
    {#if n.stale.length}
      <Icon name="warning" size={15} class="warn icon" />
    {:else}
      <Icon name={ICON[kind]} size={15} class="muted icon" />
    {/if}
    <div class="stack">
      <span class="wrap">{n.text}</span>
      {#if n.stale.length}
        <span class="stale">
          {n.stale.join(", ")} changed since this was saved. It may be out of date.
        </span>
      {/if}
      <span class="meta small">
        {#if n.at !== undefined}<span class="muted">{relativeTime(n.at, now)}</span>{/if}
        {#each n.files as f, i (i)}
          <button type="button" class="link-btn mono" title="Open {f.path}" onclick={() => store.open(f.key)}>{f.path}</button>
        {/each}
        {#each n.tags as t, i (i)}<span class="tag">{t}</span>{/each}
      </span>
    </div>
  </div>
{/snippet}

<style>
  .hero :global(.syn) {
    color: var(--syn);
  }
  .current {
    border-color: var(--syn-edge);
  }
  .row :global(.icon) {
    margin-top: 2px;
  }
  .row :global(.warn) {
    color: var(--warning);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin-top: 2px;
  }
  .link {
    color: var(--link);
  }
</style>
