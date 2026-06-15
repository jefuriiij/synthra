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

  // Group the (already project→personal→plugin-by-source sorted) list into
  // labeled sections. Map preserves insertion order, so section order is right.
  const groups = $derived.by(() => {
    const map = new Map<string, { label: string; scope: string; items: typeof items }>();
    for (const it of items) {
      const key = it.scope === "plugin" ? `plugin:${it.source ?? "plugin"}` : it.scope;
      let g = map.get(key);
      if (!g) {
        g = {
          label:
            it.scope === "plugin"
              ? (it.source ?? "plugin")
              : it.scope === "project"
                ? "In this project"
                : "Personal · this machine",
          scope: it.scope,
          items: [],
        };
        map.set(key, g);
      }
      g.items.push(it);
    }
    return [...map.values()];
  });

  function scopeColor(scope: string): string {
    return scope === "project"
      ? "var(--c-fable)"
      : scope === "personal"
        ? "var(--c-sonnet)"
        : "#9bc2ef";
  }
  const scanned = $derived(
    a ? new Date(a.scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
  );
</script>

<div class="flex h-full flex-col gap-4 p-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="font-serif text-2xl text-foreground">⚔ Arsenal</h1>
    <div class="flex items-center gap-2 font-mono text-xs text-muted-foreground">
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
  {:else if !groups.length}
    <div class="text-sm text-muted-foreground">{q ? "No matches." : "Nothing installed in this category."}</div>
  {:else}
    <div class="flex flex-col gap-6">
      {#each groups as g (g.label + g.scope)}
        <section class="flex flex-col gap-2">
          <div class="flex items-center gap-3 border-b border-border pb-1.5">
            <span class="size-1.5 shrink-0 rounded-sm" style={`background:${scopeColor(g.scope)}`}></span>
            <span
              class="font-mono text-xs uppercase tracking-[0.14em]"
              style={`color:${scopeColor(g.scope)}`}
            >{g.label}</span>
            <span class="font-mono text-xs tracking-[0.1em] text-muted-foreground">{g.items.length}</span>
          </div>
          <div class="grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {#each g.items as it (it.scope + (it.source ?? "") + it.name)}
              <ArsenalItem item={it} />
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>
