<script lang="ts">
  import type { CapabilitiesTab, CapabilityKind, CapabilityRow } from "../../shared/tabs";
  import { plural, relativeTime } from "../../shared/time";
  import { store } from "../lib/store.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import Menu, { type MenuItem } from "./Menu.svelte";

  let { capabilities: c, now }: { capabilities: CapabilitiesTab; now: number } = $props();

  type Kind = CapabilityKind | "plugins";
  const KINDS: { id: Kind; label: string }[] = [
    { id: "skills", label: "Skills" },
    { id: "agents", label: "Agents" },
    { id: "mcp", label: "Connected tools" },
    { id: "plugins", label: "Plugins" },
  ];
  const size = (k: Kind) => (k === "plugins" ? c.plugins.length : c[k].length);

  // Two chips that cut across where a skill lives.
  const SYNTHRA = " synthra";
  const FAVORITES = " favorites";

  let kind = $state<Kind>("skills");
  let group = $state("all");
  let query = $state("");
  const needle = $derived(query.trim().toLowerCase());

  const rows = $derived(kind === "plugins" ? [] : c[kind]);
  /** Only groups that have rows get a chip: this project, yours, then plugins. */
  const groups = $derived.by(() => {
    const order = ["This project", "Yours"];
    const names = [...new Set(rows.map((r) => r.group))];
    return names.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 9 : ia) - (ib === -1 ? 9 : ib);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  });
  const mine = $derived(rows.filter((r) => r.synthra).length);
  const favorites = $derived(rows.filter((r) => r.favorite).length);
  const inGroup = (r: CapabilityRow, g: string) =>
    g === "all" || (g === SYNTHRA ? r.synthra === true : g === FAVORITES ? r.favorite === true : r.group === g);
  const shown = $derived(
    rows.filter(
      (r) =>
        inGroup(r, group) &&
        (!needle ||
          r.name.toLowerCase().includes(needle) ||
          r.description.toLowerCase().includes(needle) ||
          r.group.toLowerCase().includes(needle)),
    ),
  );

  /** Rows before "Show all" (a filter shows every match). */
  const FIRST = 12;
  let all = $state(false);
  const visible = $derived(all || needle ? shown : shown.slice(0, FIRST));

  function pick(k: Kind): void {
    kind = k;
    group = "all";
    all = false;
    stopMerge();
  }
  function chip(g: string): void {
    group = g;
    all = false;
  }

  const icon = (r: CapabilityRow): IconName =>
    kind === "mcp"
      ? "plug"
      : r.synthra
        ? "sparkle"
        : r.scope === "project"
          ? "repo"
          : r.scope === "personal"
            ? "person"
            : "package";

  // ─── support files ───
  let openFiles = $state<Record<string, boolean>>({});
  const toggleFiles = (id: string) => (openFiles = { ...openFiles, [id]: !openFiles[id] });

  // ─── merge ───
  let merging = $state(false);
  let picked = $state<string[]>([]);
  const mergeable = $derived(rows.filter((r) => r.canMerge && r.path));
  function startMerge(first?: string): void {
    merging = true;
    picked = first ? [first] : [];
    store.mergeError = "";
  }
  function stopMerge(): void {
    merging = false;
    picked = [];
  }
  function togglePick(path: string): void {
    picked = picked.includes(path) ? picked.filter((p) => p !== path) : [...picked, path];
  }
  // The request is on the clipboard: leave merge mode.
  let asked = $state(false);
  $effect(() => {
    if (asked && !store.merging) {
      asked = false;
      if (!store.mergeError) stopMerge();
    }
  });
  function merge(): void {
    asked = true;
    store.merge(picked);
  }

  function menu(r: CapabilityRow): MenuItem[] {
    const path = r.path ?? "";
    const items: MenuItem[] = [];
    if (r.key) items.push({ label: "Open", icon: "file", hint: "click the name", run: () => store.open(r.key) });
    if (r.edit) items.push({ label: "Edit", icon: "pencil", run: () => store.open(r.edit) });
    if (r.canFavorite) {
      items.push({
        label: r.favorite ? "Remove from favorites" : "Add to favorites",
        icon: r.favorite ? "star-full" : "star",
        ...(r.synthra ? { hint: "the Curator keeps it" } : {}),
        disabled: store.skillBusy[path],
        run: () => store.skill({ type: "favorite", path, on: !r.favorite }),
      });
    }
    if (r.canMerge) {
      items.push({ label: "Merge with others...", icon: "merge", sep: true, run: () => startMerge(path) });
    }
    if (r.canDelete) {
      items.push({
        label: "Delete...",
        icon: "trash",
        danger: true,
        sep: true,
        disabled: store.skillBusy[path],
        run: () => store.skill({ type: "deleteSkill", path }),
      });
    } else if (r.thirdParty) {
      items.push({
        label: `Installed from ${r.thirdParty}`,
        icon: "package",
        sep: true,
        disabled: true,
        run: () => {},
      });
    }
    return items;
  }
</script>

<div class="hero">
  <Icon name="capabilities" size={26} class="syn" />
  <div class="stack">
    <span class="headline">
      Claude can use {plural(c.skills.length, "skill")}, {plural(c.agents.length, "agent")} and {plural(c.mcp.length, "connected tool")}
    </span>
    <span class="small muted">
      From this project, from you, and from {plural(c.plugins.length, "plugin")}{c.skills.some((r) => r.synthra)
        ? ` · ${c.skills.filter((r) => r.synthra).length} made by Synthra`
        : ""}. Click a name to open it.
    </span>
  </div>
</div>

{#if c.error}
  <p class="stale">Synthra couldn't list your skills and tools: {c.error}</p>
{:else}
  <div class="bar">
    <div class="seg" role="group" aria-label="What to list">
      {#each KINDS as k (k.id)}
        <button type="button" aria-pressed={kind === k.id} onclick={() => pick(k.id)}>
          {k.label} · {size(k.id)}
        </button>
      {/each}
    </div>
  </div>

  {#if kind === "plugins"}
    {#if c.plugins.length === 0}
      <p class="empty">No Claude Code plugins add skills, agents or tools here.</p>
    {:else}
      <div class="card">
        {#each c.plugins as p (p.name)}
          <div class="row">
            <Icon name="package" size={15} class="muted icon" />
            <div class="stack">
              <span class="mono">{p.name}</span>
              <span class="small muted">
                {[
                  p.skills ? plural(p.skills, "skill") : "",
                  p.agents ? plural(p.agents, "agent") : "",
                  p.mcp ? plural(p.mcp, "tool") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <span class="state small">
              <span class="dot" class:on={!p.off}></span>{p.off ? "off" : "on"}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  {:else if rows.length === 0}
    <p class="empty">
      {kind === "skills"
        ? "No skills found."
        : kind === "agents"
          ? "No agents found. Agents are .md files in .claude/agents/."
          : "No MCP servers found in .mcp.json or your Claude config."}
    </p>
  {:else}
    <div class="search">
      <Icon name="search" size={14} />
      <label for="cap-filter" class="sr-only">Filter</label>
      <input id="cap-filter" bind:value={query} type="text" placeholder="Filter {rows.length} {KINDS.find((k) => k.id === kind)?.label.toLowerCase()}" />
    </div>

    {#if groups.length > 1 || mine || favorites}
      <div class="chips" role="group" aria-label="Which ones to show">
        <button type="button" class="chip" aria-pressed={group === "all"} onclick={() => chip("all")}>
          All <span class="n">{rows.length}</span>
        </button>
        {#if mine}
          <button type="button" class="chip" aria-pressed={group === SYNTHRA} onclick={() => chip(SYNTHRA)}>
            <Icon name="sparkle" size={11} class="syn" /> Made by Synthra <span class="n">{mine}</span>
          </button>
        {/if}
        {#if favorites}
          <button type="button" class="chip" aria-pressed={group === FAVORITES} onclick={() => chip(FAVORITES)}>
            <Icon name="star-full" size={11} class="fav" /> Favorites <span class="n">{favorites}</span>
          </button>
        {/if}
        {#if groups.length > 1}
          {#each groups as g (g)}
            <button type="button" class="chip" aria-pressed={group === g} onclick={() => chip(g)}>
              {g}
              <span class="n">{rows.filter((r) => r.group === g).length}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    {#if merging}
      <div class="mergebar">
        <Icon name="merge" size={16} class="syn" />
        <div class="stack">
          <strong>{picked.length < 2 ? "Pick the skills to merge" : `Merge ${picked.length} skills`}</strong>
          <span class="small muted">
            Pick skills that are one kind of work. Claude proposes one skill that holds them all, and every change waits for your OK.
          </span>
          {#if store.mergeError}<span class="stale">{store.mergeError}</span>{/if}
        </div>
        <button type="button" class="btn primary" disabled={picked.length < 2 || store.merging} onclick={merge}>
          Merge {picked.length >= 2 ? picked.length : ""} skills
        </button>
        <button type="button" class="btn" onclick={stopMerge}>Cancel</button>
      </div>
    {/if}

    {#if shown.length === 0}
      <p class="empty">
        {needle ? `Nothing matches "${query.trim()}".` : "None here yet."}
      </p>
    {:else}
      <div class="card">
        {#each visible as r (r.id)}
          {#if kind === "skills" && r.path}
            {@const path = r.path}
            <div class="row" class:dim={merging && !r.canMerge}>
              {#if merging}
                <input
                  type="checkbox"
                  class="pick"
                  aria-label="Merge {r.name}"
                  disabled={!r.canMerge}
                  checked={picked.includes(path)}
                  onchange={() => togglePick(path)}
                />
              {/if}
              <Icon name={icon(r)} size={15} class={r.synthra ? "syn icon" : "muted icon"} />
              <span class="stack">
                <span class="name-line">
                  {#if r.key}
                    <button type="button" class="link-btn mono name" title="Open its SKILL.md" onclick={() => store.open(r.key)}>{r.name}</button>
                  {:else}
                    <span class="mono name">{r.name}</span>
                  {/if}
                  {@render tags(r)}
                </span>
                {#if r.description}<span class="small muted clamp2">{r.description}</span>{/if}
                {#if r.uses || r.files?.length}
                  <span class="meta small muted">
                    {#if r.uses}
                      <span>used {plural(r.uses, "time")}{r.lastUsed !== undefined ? ` · last used ${relativeTime(r.lastUsed, now)}` : ""}</span>
                    {/if}
                    {#if r.files?.length}
                      <button type="button" class="link-btn files-toggle" aria-expanded={openFiles[r.id] === true} onclick={() => toggleFiles(r.id)}>
                        <span class="chev" class:open={openFiles[r.id]}><Icon name="chevron" size={10} /></span>
                        {plural(r.files.length + (r.filesMore ?? 0), "file")}
                      </button>
                    {/if}
                  </span>
                {/if}
                {#if openFiles[r.id] && r.files}
                  <span class="files">
                    {#each r.files as f (f.path)}
                      <button type="button" class="link-btn mono small" onclick={() => store.open(f.key)}>{f.path}</button>
                    {/each}
                    {#if r.filesMore}<span class="small muted">and {r.filesMore} more</span>{/if}
                  </span>
                {/if}
                {#if store.skillErrors[path]}<span class="stale">{store.skillErrors[path]}</span>{/if}
              </span>
              {#if !merging}<Menu items={menu(r)} label="Actions for {r.name}" />{/if}
            </div>
          {:else if r.key}
            <button type="button" class="row-btn" title="Open its file" onclick={() => store.open(r.key)}>
              {@render body(r)}
            </button>
          {:else}
            <div class="row">{@render body(r)}</div>
          {/if}
        {/each}
        {#if !needle && shown.length > FIRST}
          <button type="button" class="row-btn small link" onclick={() => (all = !all)}>
            {all ? "Show fewer" : `Show all ${shown.length}`}
          </button>
        {/if}
      </div>
    {/if}
    {#if kind === "skills" && !merging && mergeable.length >= 2}
      <p class="empty">
        Too many narrow skills? <button type="button" class="link-btn" onclick={() => startMerge()}>Merge some into one</button>.
      </p>
    {/if}
  {/if}
{/if}

{#snippet tags(r: CapabilityRow)}
  {#if r.synthra}<span class="tag syn-tag"><Icon name="sparkle" size={10} /> Synthra</span>{/if}
  {#if r.thirdParty}<span class="tag">from {r.thirdParty}</span>{/if}
  {#if r.linkedTo}<span class="tag" title="A link to {r.linkedTo}"><Icon name="link" size={11} /> linked</span>{/if}
  {#if r.favorite}<span class="tag"><Icon name="star-full" size={10} class="fav" /> favorite</span>{/if}
  {#if r.staleDays !== undefined}<span class="tag warn-tag">unused {r.staleDays} days</span>{/if}
  {#if r.extra}<span class="small muted">{r.extra}</span>{/if}
  {#if r.off}<span class="tag">off</span>{/if}
  {#if group === "all" && groups.length > 1}<span class="tag">{r.group}</span>{/if}
{/snippet}

{#snippet body(r: CapabilityRow)}
  <Icon name={icon(r)} size={15} class="muted icon" />
  <span class="stack">
    <span class="name-line">
      <span class="mono name">{r.name}</span>
      {@render tags(r)}
    </span>
    {#if r.description}<span class="small muted clamp2">{r.description}</span>{/if}
  </span>
{/snippet}

<style>
  .hero :global(.syn),
  .row :global(.syn),
  .chip :global(.syn),
  .mergebar :global(.syn) {
    color: var(--syn);
  }
  :global(.fav) {
    color: var(--vscode-charts-yellow, #d7ba7d);
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .row :global(.icon),
  .row-btn :global(.icon) {
    margin-top: 2px;
  }
  .row {
    align-items: flex-start;
  }
  .row.dim {
    opacity: 0.5;
  }
  .name-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    min-width: 0;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .link-btn.name {
    color: var(--fg);
  }
  .link-btn.name:hover {
    color: var(--link);
  }
  .tag {
    gap: 4px;
  }
  .syn-tag {
    border-color: var(--syn-edge);
    color: var(--syn);
  }
  .warn-tag {
    border-color: transparent;
    background: var(--warn-tint);
    color: var(--warning);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 10px;
  }
  .files-toggle {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--link);
  }
  .chev {
    display: inline-flex;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .files {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    margin-top: 2px;
  }
  .files .link-btn {
    color: var(--link);
  }
  .pick {
    margin: 3px 0 0;
    flex-shrink: 0;
    accent-color: var(--vscode-button-background);
  }
  .mergebar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--syn-edge);
    border-radius: 8px;
    background: var(--syn-tint);
  }
  .mergebar .stack {
    min-width: 200px;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
  }
  .dot {
    background: var(--muted);
  }
  .dot.on {
    background: var(--success);
  }
  .link {
    color: var(--link);
  }
</style>
