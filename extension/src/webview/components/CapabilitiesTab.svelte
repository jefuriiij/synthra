<script lang="ts">
  import type { CapabilitiesTab, CapabilityKind, CapabilityRow } from "../../shared/tabs";
  import { plural } from "../../shared/time";
  import { store } from "../lib/store.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

  let { capabilities: c }: { capabilities: CapabilitiesTab } = $props();

  type Kind = CapabilityKind | "plugins";
  const KINDS: { id: Kind; label: string }[] = [
    { id: "skills", label: "Skills" },
    { id: "agents", label: "Agents" },
    { id: "mcp", label: "Connected tools" },
    { id: "plugins", label: "Plugins" },
  ];
  const size = (k: Kind) => (k === "plugins" ? c.plugins.length : c[k].length);

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
  const shown = $derived(
    rows.filter(
      (r) =>
        (group === "all" || r.group === group) &&
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
  }

  const icon = (r: CapabilityRow): IconName =>
    kind === "mcp" ? "plug" : r.scope === "project" ? "repo" : r.scope === "personal" ? "person" : "package";
</script>

<div class="hero">
  <Icon name="capabilities" size={26} class="syn" />
  <div class="stack">
    <span class="headline">
      Claude can use {plural(c.skills.length, "skill")}, {plural(c.agents.length, "agent")} and {plural(c.mcp.length, "connected tool")}
    </span>
    <span class="small muted">
      From this project, from you, and from {plural(c.plugins.length, "plugin")}. Click one to open its file.
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

    {#if groups.length > 1}
      <div class="chips" role="group" aria-label="Where they come from">
        {#each ["all", ...groups] as g (g)}
          <button type="button" class="chip" aria-pressed={group === g} onclick={() => { group = g; all = false; }}>
            {g === "all" ? "All" : g}
            <span class="n">{g === "all" ? rows.length : rows.filter((r) => r.group === g).length}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if shown.length === 0}
      <p class="empty">Nothing matches “{query.trim()}”.</p>
    {:else}
      <div class="card">
        {#each visible as r (r.id)}
          {#if r.key}
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
  {/if}
{/if}

{#snippet body(r: CapabilityRow)}
  <Icon name={icon(r)} size={15} class="muted icon" />
  <span class="stack">
    <span class="name-line">
      <span class="mono name">{r.name}</span>
      {#if r.extra}<span class="small muted">{r.extra}</span>{/if}
      {#if r.off}<span class="tag">off</span>{/if}
      {#if group === "all" && groups.length > 1}<span class="tag">{r.group}</span>{/if}
    </span>
    {#if r.description}<span class="small muted clamp2">{r.description}</span>{/if}
  </span>
{/snippet}

<style>
  .hero :global(.syn) {
    color: var(--syn);
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
