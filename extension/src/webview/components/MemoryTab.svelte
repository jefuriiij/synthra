<script lang="ts">
  import type { KnowledgeCard, MemoryKind, MemoryNote, MemoryTab } from "../../shared/tabs";
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

  const cardEntries = (c: KnowledgeCard) =>
    needle ? c.entries.filter((e) => e.toLowerCase().includes(needle)) : c.entries;
  const facts = $derived(memory.files.reduce((n, c) => n + c.entries.length, 0));
  const searchable = $derived(memory.total + facts);
  const fmt = (n: number) => n.toLocaleString("en-US");

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
        Synthra can't read this branch's session notes
      {:else if memory.total === 0 && facts === 0}
        Nothing remembered here yet
      {:else}
        Synthra remembers {plural(facts, "fact")} and {plural(memory.total, "session note")} on {memory.branch || "this branch"}
      {/if}
    </span>
    <span class="small muted">
      {#if memory.unreadable}
        {memory.unreadable}
      {:else if memory.total === 0}
        Facts go in the two files below. Claude saves session notes with context_remember: decisions, tasks, next steps.
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
    <button type="button" class="link-btn small" onclick={() => store.open(memory.store)}>Open the session notes file</button>
  {/if}
</div>

{#if searchable > 0}
  <div class="search">
    <Icon name="search" size={14} />
    <label for="memory-filter" class="sr-only">Filter</label>
    <input id="memory-filter" bind:value={query} type="text" placeholder="Filter {searchable} facts and notes by text, tag or file" />
  </div>
{/if}

{#if memory.files.length}
  <h2 class="section-label" title="Both files load at the start of every session, for Claude and, through AGENTS.md, for other AI tools.">
    <Icon name="book" size={13} />
    Loaded in every session
  </h2>
  <div class="files">
    {#each memory.files as c (c.target)}
      {@const shown = cardEntries(c)}
      {@const over = c.chars > c.limit}
      <div class="card file" title={c.hint}>
        <div class="row file-head">
          <Icon name={c.target === "project" ? "book" : "person"} size={15} class="muted icon" />
          <div class="stack">
            <span class="name-line">
              <span class="headline-sm">{c.title}</span>
              <span class="mono small muted">{c.shownPath}</span>
            </span>
            <span class="usage">
              <span class="track"><span class="fill" class:over style="width: {Math.min(100, (c.chars / Math.max(1, c.limit)) * 100)}%"></span></span>
              <span class="small" class:muted={!over} class:warn-text={over}>
                {fmt(c.chars)} / {fmt(c.limit)} chars{over ? " · over the limit" : ""}
              </span>
            </span>
          </div>
          {#if c.key}
            <button type="button" class="link-btn small" onclick={() => store.open(c.key)}>Open</button>
          {/if}
        </div>
        {#if !c.exists}
          <p class="row small muted">Not created yet. It is made the first time an AI saves something here.</p>
        {:else if c.entries.length === 0}
          <p class="row small muted">Empty. Claude adds facts with the memory tool; other AIs edit the file by hand.</p>
        {:else if shown.length === 0}
          <p class="row small muted">No entries match.</p>
        {:else}
          <ul class="row entries">
            {#each shown as e, i (i)}<li class="wrap small">{e}</li>{/each}
          </ul>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if needle && sections.length === 0 && memory.total > 0}
  <p class="empty">No session notes match “{query.trim()}”.</p>
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
  .files {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 12px;
  }
  .file-head {
    align-items: flex-start;
  }
  .name-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
  }
  .headline-sm {
    font-weight: 600;
  }
  .usage {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .track {
    flex: 1;
    max-width: 160px;
    height: 5px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--syn);
  }
  .fill.over {
    background: var(--warning);
  }
  .warn-text {
    color: var(--warning);
  }
  .entries {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding-left: 30px;
    list-style: disc;
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
