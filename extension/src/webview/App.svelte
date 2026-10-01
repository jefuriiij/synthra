<script lang="ts">
  import { tick } from "svelte";

  import type { Tab } from "../shared/tabs";
  import AgentsTab from "./components/AgentsTab.svelte";
  import CapabilitiesTab from "./components/CapabilitiesTab.svelte";
  import Icon, { type IconName } from "./components/Icon.svelte";
  import MemoryTab from "./components/MemoryTab.svelte";
  import SettingsTab from "./components/SettingsTab.svelte";
  import SynthraMark from "./components/SynthraMark.svelte";
  import { store } from "./lib/store.svelte";

  const TABS: { id: Tab; label: string; icon: IconName }[] = [
    { id: "memory", label: "Memory", icon: "memory" },
    { id: "capabilities", label: "Capabilities", icon: "capabilities" },
    { id: "agents", label: "Agents", icon: "agents" },
    { id: "settings", label: "Settings", icon: "gear" },
  ];

  const view = $derived(store.view);

  /** The count beside each tab's name. */
  const counts = $derived<Record<Tab, number | undefined>>({
    memory: view?.memory?.total,
    capabilities: view?.capabilities
      ? view.capabilities.skills.length + view.capabilities.agents.length + view.capabilities.mcp.length
      : undefined,
    agents: view?.agents?.recent.length,
    settings: undefined,
  });

  /** Re-read once a minute so "12 min ago" keeps moving while the page is open. */
  let now = $state(Date.now());
  $effect(() => {
    const timer = window.setInterval(() => (now = Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });

  /** Arrow keys move between tabs (and switch), as a tab list does. */
  function onkeydown(e: KeyboardEvent): void {
    const i = TABS.findIndex((t) => t.id === store.tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    const tab = TABS[next];
    if (!tab) return;
    e.preventDefault();
    store.setTab(tab.id);
    void tick().then(() => document.getElementById(`tab-${tab.id}`)?.focus());
  }
</script>

<div class="page">
  <header class="header">
    <SynthraMark />
    <span class="title">Synthra</span>
    {#if view}
      <span class="where muted">
        {view.project}{view.memory?.branch ? ` · ${view.memory.branch}` : ""}
      </span>
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="icon-btn"
      title="Read everything again"
      aria-label="Refresh"
      disabled={store.refreshing}
      onclick={() => store.refresh()}
    >
      <Icon name={store.refreshing ? "spin" : "refresh"} />
    </button>
  </header>

  <div class="tabs" role="tablist" aria-label="Synthra">
    {#each TABS as t (t.id)}
      {@const selected = store.tab === t.id}
      <button
        type="button"
        role="tab"
        id="tab-{t.id}"
        aria-selected={selected}
        aria-controls="panel-{t.id}"
        tabindex={selected ? 0 : -1}
        class="tab"
        onclick={() => store.setTab(t.id)}
        {onkeydown}
      >
        <Icon name={t.icon} />
        <span>{t.label}</span>
        {#if counts[t.id]}<span class="count">{counts[t.id]}</span>{/if}
      </button>
    {/each}
  </div>

  <div class="scroll" role="tabpanel" id="panel-{store.tab}" aria-labelledby="tab-{store.tab}">
    <div class="content">
      {#if !view}
        <p class="empty">Reading what Synthra knows…</p>
      {:else if view.message}
        <p class="empty">{view.message}</p>
      {:else if store.tab === "memory" && view.memory}
        <MemoryTab memory={view.memory} {now} />
      {:else if store.tab === "capabilities" && view.capabilities}
        <CapabilitiesTab capabilities={view.capabilities} />
      {:else if store.tab === "agents" && view.agents}
        <AgentsTab agents={view.agents} {now} />
      {:else if store.tab === "settings"}
        {#if view.settings}
          <SettingsTab settings={view.settings} />
        {:else}
          <p class="empty">This version of Synthra has no settings. Update Synthra to 0.33 or later.</p>
        {/if}
      {/if}
    </div>
  </div>
</div>
