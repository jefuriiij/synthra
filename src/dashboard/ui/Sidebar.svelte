<script lang="ts">
  import { store } from "$lib/store.svelte";
  import { shortenPath } from "$lib/format";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import Swords from "@lucide/svelte/icons/swords";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import CircleHelp from "@lucide/svelte/icons/circle-help";
  import PanelLeft from "@lucide/svelte/icons/panel-left";

  let { onFaq }: { onFaq: () => void } = $props();
  let collapsed = $state(false);

  const port = typeof window !== "undefined" ? window.location.port || "8901" : "8901";

  const nav = [
    { id: "overview" as const, label: "Overview", icon: LayoutDashboard },
    { id: "arsenal" as const, label: "Arsenal", icon: Swords },
    { id: "commands" as const, label: "Commands", icon: SquareTerminal },
  ];
</script>

<aside
  class={"flex h-screen shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3 transition-[width] duration-200 " +
    (collapsed ? "w-[64px] items-center" : "w-[248px]")}
>
  <!-- Brand -->
  <div class="flex items-center gap-2.5 px-1 py-2">
    <div class="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/90 font-serif text-lg italic text-primary-foreground">S</div>
    {#if !collapsed}
      <div class="min-w-0">
        <div class="font-serif text-lg leading-none text-foreground">Synth<em>ra</em></div>
        <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Dashboard</div>
      </div>
    {/if}
  </div>

  <!-- Status -->
  <div class={"flex items-center gap-2 rounded-md px-2 py-1.5 " + (collapsed ? "justify-center" : "")}>
    <span
      class={"size-2 shrink-0 rounded-full " +
        (store.status === "live" ? "bg-[var(--c-fable)]" : store.status === "offline" ? "bg-destructive" : "bg-muted-foreground")}
      class:animate-pulse={store.status === "live"}
    ></span>
    {#if !collapsed}
      <span class="font-mono text-sm text-muted-foreground">
        {store.status === "live" ? `live · ${store.clock}` : store.status}
      </span>
    {/if}
  </div>

  <div class="my-1 h-px bg-sidebar-border"></div>

  <!-- Nav -->
  <nav class="flex flex-col gap-1">
    {#each nav as item (item.id)}
      <button
        onclick={() => store.go(item.id)}
        title={item.label}
        class={"flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors " +
          (store.view === item.id
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground") +
          (collapsed ? " justify-center" : "")}
      >
        <item.icon class="size-4 shrink-0" />
        {#if !collapsed}<span>{item.label}</span>{/if}
      </button>
    {/each}
    <button
      onclick={onFaq}
      title="FAQ"
      class={"flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground " +
        (collapsed ? "justify-center" : "")}
    >
      <CircleHelp class="size-4 shrink-0" />
      {#if !collapsed}<span>FAQ</span>{/if}
    </button>
  </nav>

  <div class="flex-1"></div>

  <!-- Footer: active project · port · version -->
  {#if !collapsed}
    <div class="flex flex-col gap-1 rounded-lg bg-sidebar-accent/40 p-2.5">
      <div class="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Active</div>
      <div class="truncate font-mono text-sm text-sidebar-foreground" title={store.data?.active?.project_root ?? "—"}>
        {store.data?.active?.project_name ?? "—"}
      </div>
      <div class="mt-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
        <span>port {port}</span>
        <span>v__SYN_VERSION__</span>
      </div>
    </div>
  {/if}

  <button
    onclick={() => (collapsed = !collapsed)}
    title="Toggle sidebar"
    class={"mt-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground " +
      (collapsed ? "justify-center" : "")}
  >
    <PanelLeft class="size-4 shrink-0" />
    {#if !collapsed}<span class="text-xs">Collapse</span>{/if}
  </button>
</aside>
