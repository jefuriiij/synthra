<script lang="ts">
  import { store } from "$lib/store.svelte";
  import ArsenalItem from "./ArsenalItem.svelte";

  type Tab = "skills" | "agents" | "mcp";
  let tab = $state<Tab>("skills");
  let q = $state("");

  const a = $derived(store.arsenal);
  const tabs: { id: Tab; label: string }[] = [
    { id: "skills", label: "Skills" },
    { id: "agents", label: "Agents" },
    { id: "mcp", label: "MCP" },
  ];
  const items = $derived.by(() => {
    const list = a ? a[tab] : [];
    const needle = q.toLowerCase().trim();
    if (!needle) return list;
    return list.filter(
      (it) =>
        it.name.toLowerCase().includes(needle) ||
        (it.description ?? "").toLowerCase().includes(needle) ||
        (it.source ?? "").toLowerCase().includes(needle),
    );
  });
  const scanned = $derived(
    a ? new Date(a.scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
  );
</script>

<div class="flex h-full flex-col gap-4 p-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="font-serif text-2xl text-foreground">⚔ Arsenal</h1>
    <div class="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
      {#if a}<span>{a.counts.plugins} plugins · scanned {scanned}</span>{/if}
      <button onclick={() => store.loadArsenal(true)} class="rounded border px-2 py-1 transition-colors hover:text-foreground">↻ Rescan</button>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    {#each tabs as t (t.id)}
      <button
        onclick={() => (tab = t.id)}
        class={"rounded-lg px-3 py-1.5 font-mono text-xs transition-colors " +
          (tab === t.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
      >
        {t.label} <span class="opacity-60">{a?.counts?.[t.id] ?? 0}</span>
      </button>
    {/each}
    <input
      bind:value={q}
      placeholder="Filter by name or description…"
      autocomplete="off"
      class="ml-auto w-full max-w-72 rounded-md border bg-card/60 px-3 py-1.5 text-sm outline-none transition-colors focus:border-ring"
    />
  </div>

  {#if store.arsenalLoading && !a}
    <div class="text-sm text-muted-foreground">Scanning your arsenal…</div>
  {:else}
    <div class="grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-3">
      {#each items as it (it.scope + (it.source ?? "") + it.name)}
        <ArsenalItem item={it} />
      {:else}
        <div class="text-sm text-muted-foreground">{q ? "No matches." : "Nothing installed in this category."}</div>
      {/each}
    </div>
  {/if}
</div>
