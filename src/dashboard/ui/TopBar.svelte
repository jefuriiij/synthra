<script lang="ts">
  import { store, type Days } from "$lib/store.svelte";

  let { onFaq, onReport }: { onFaq: () => void; onReport: () => void } = $props();
  const ranges: { days: Days; label: string }[] = [
    { days: 7, label: "This week" },
    { days: 30, label: "This month" },
  ];
</script>

<header class="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
  <div class="mx-auto flex max-w-[1120px] items-center gap-3 px-7 py-3">
    <div class="grid size-8 place-items-center rounded-lg bg-primary font-serif text-lg italic text-primary-foreground">S</div>
    <div class="font-serif text-xl leading-none text-foreground">Synth<em>ra</em></div>
    <span class="ml-2 inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
      <span
        class={"size-1.5 rounded-full " +
          (store.status === "live" ? "bg-money" : store.status === "offline" ? "bg-destructive" : "bg-muted-foreground")}
      ></span>
      {store.overview?.project.name ?? "…"} · {store.status === "live" ? store.clock : store.status}
    </span>
    <div class="flex-1"></div>
    <div class="flex rounded-lg border border-border bg-card p-0.5">
      {#each ranges as r (r.days)}
        <button
          onclick={() => store.setDays(r.days)}
          class={"rounded-md px-3 py-1 text-[13px] transition-colors " +
            (store.days === r.days ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {r.label}
        </button>
      {/each}
    </div>
    <button onclick={onReport} class="rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-card hover:text-foreground">Report a problem</button>
    <button onclick={onFaq} class="rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-card hover:text-foreground">FAQ</button>
  </div>
</header>
