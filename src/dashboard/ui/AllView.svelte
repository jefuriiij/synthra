<script lang="ts">
  import { store } from "$lib/store.svelte";
  import { CountUp } from "$lib/countup";
  import { fmt, fmtCost, fmtTs, modelLabel } from "$lib/format";
  import { projectDot } from "$lib/health";
  import Section from "./Section.svelte";
  import StatusBanner from "./StatusBanner.svelte";
  import HealthTable from "./HealthTable.svelte";

  const o = $derived(store.overview);
  const c = $derived(o?.cost);
  const f = $derived(o?.finding);
  const word = $derived(store.days === 30 ? "month" : "week");
  const change = $derived(
    c && c.spend > 0 && c.previous > 0 ? Math.round(((c.spend - c.previous) / c.previous) * 100) : null,
  );
  const lookups = $derived(f ? f.map + f.files + f.search : 0);
  const busy = $derived((o?.projects ?? []).filter((p) => p.replies > 0).length);
  const warn = $derived((o?.health ?? []).filter((h) => projectDot(h) === "warn"));
  const spenders = $derived((o?.projects ?? []).filter((p) => p.spend > 0).sort((a, b) => b.spend - a.spend));
  const top = $derived(spenders[0]?.spend ?? 1);
  const finders = $derived(
    (o?.projects ?? [])
      .filter((p) => p.map + p.files + p.search > 0)
      .sort((a, b) => b.map + b.files + b.search - (a.map + a.files + a.search)),
  );
  const pathOf = (name: string) => o?.projects?.find((p) => p.name === name)?.path;
  const spend = new CountUp();
  $effect(() => spend.set(c?.spend ?? 0));
  const tile = "rounded-2xl border border-border bg-linear-to-b from-[#0c1a3a] to-card px-5 py-4";
</script>

<div class="mb-5 flex flex-wrap items-end gap-x-4 gap-y-2">
  <h1 class="font-serif text-[40px] font-normal leading-none">All projects <em class="text-muted-foreground">this {word}</em></h1>
</div>

<div class="grid grid-cols-12 gap-4">
  <div class="col-span-12"><StatusBanner /></div>

  <div class={tile + " col-span-12 sm:col-span-6 xl:col-span-3"}>
    <div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">Spend</div>
    <div class="mt-1 font-mono text-[30px] font-medium leading-tight text-money">{fmtCost(spend.value)}</div>
    <div class="text-[13px] text-muted-foreground">
      {#if change !== null}<span class={change > 0 ? "text-destructive" : "text-money"}>{change > 0 ? "+" : ""}{change}%</span> vs last {word}{:else}at API prices{/if}
    </div>
  </div>
  <div class={tile + " col-span-12 sm:col-span-6 xl:col-span-3"}>
    <div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">Replies</div>
    <div class="mt-1 font-mono text-[30px] font-medium leading-tight">{fmt(c?.replies ?? 0)}</div>
    <div class="text-[13px] text-muted-foreground">in {busy} {busy === 1 ? "project" : "projects"}</div>
  </div>
  <div class={tile + " col-span-12 sm:col-span-6 xl:col-span-3"}>
    <div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">Map share</div>
    <div class="mt-1 font-mono text-[30px] font-medium leading-tight">{lookups ? Math.round(((f?.map ?? 0) / lookups) * 100) : 0}%</div>
    <div class="text-[13px] text-muted-foreground">{fmt(f?.map ?? 0)} of {fmt(lookups)} lookups used the map</div>
  </div>
  <div class={tile + " col-span-12 sm:col-span-6 xl:col-span-3"}>
    <div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">Needs a look</div>
    <div class={"mt-1 font-mono text-[30px] font-medium leading-tight " + (warn.length ? "text-sonnet" : "")}>{warn.length}</div>
    <div class="truncate text-[13px] text-muted-foreground" title={warn.map((h) => h.name).join(", ")}>
      {warn.length ? warn.map((h) => h.name).join(", ") : "every project works"}
    </div>
  </div>

  <Section class="col-span-12" title="Is it working?" sub="When each part of Synthra last ran, per project" why="A part that stops quietly is the worst kind of bug. Click a project to open it.">
    <HealthTable />
  </Section>

  <Section class="col-span-12 xl:col-span-7" title="Cost" sub="At API prices, by project" why="On a Claude plan you pay the plan, not this. It shows what the work would cost on the API.">
    {#each spenders as p, i (p.path)}
      <button type="button" class="grid w-full grid-cols-[minmax(90px,160px)_minmax(0,1fr)_96px] items-center gap-3 rounded-md py-1.5 text-left hover:bg-ring/5" onclick={() => store.go({ kind: "project", path: p.path })}>
        <span class="truncate text-[13.5px]">{p.name}</span>
        <span class="h-2.5 overflow-hidden rounded-full bg-secondary/60">
          <span class={"block h-full rounded-full " + (i === 0 ? "bg-opus" : "bg-ring")} style={`width:${Math.max(2, (p.spend / top) * 100)}%`}></span>
        </span>
        <span class="text-right font-mono text-[13px] text-money">{fmtCost(p.spend)}</span>
      </button>
    {:else}
      <p class="text-[13px] text-muted-foreground">No replies were logged this {word}.</p>
    {/each}
  </Section>

  <Section class="col-span-12 xl:col-span-5">
    <div class="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Most expensive replies</div>
    {#each c?.priciest ?? [] as r, i (i)}
      {@const path = pathOf(r.project)}
      <div class="grid grid-cols-[1fr_auto] border-b border-border py-3 text-[13.5px]">
        <span>
          {#if path}<button type="button" class="font-medium hover:text-ring" onclick={() => store.go({ kind: "project", path })}>{r.project}</button>{:else}{r.project}{/if}
          <small class="block font-mono text-xs text-muted-foreground/70">{fmtTs(r.ts)} · {modelLabel(r.model)}</small>
        </span>
        <span class="font-mono text-[13px] text-money">{fmtCost(r.cost)}</span>
      </div>
    {:else}
      <p class="mt-2 text-[13px] text-muted-foreground">None this {word}.</p>
    {/each}
  </Section>

  <Section class="col-span-12" title="Is it helping?" sub="How Claude found code, per project" why="The more Claude uses the map, the fewer tokens it spends reading. This is the number to push up.">
    <div class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
      <span><i class="mr-1.5 inline-block size-2.5 rounded-[3px] bg-money align-[-1px]"></i><b class="font-medium text-foreground">Synthra map</b> · one function at a time</span>
      <span><i class="mr-1.5 inline-block size-2.5 rounded-[3px] bg-ring align-[-1px]"></i><b class="font-medium text-foreground">Whole files</b> · Read, cat</span>
      <span><i class="mr-1.5 inline-block size-2.5 rounded-[3px] bg-[#ff8a5b] align-[-1px]"></i><b class="font-medium text-foreground">Search</b> · grep, rg, Grep, Glob</span>
    </div>
    {#each finders as p (p.path)}
      {@const n = p.map + p.files + p.search}
      <button type="button" class="grid w-full grid-cols-[minmax(90px,160px)_minmax(0,1fr)_minmax(150px,auto)] items-center gap-3 rounded-md py-2 text-left hover:bg-ring/5" onclick={() => store.go({ kind: "project", path: p.path })}>
        <span class="truncate text-[13.5px]">{p.name}</span>
        <span class="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-secondary/60">
          {#if p.map}<span class="bg-money" style={`flex:${p.map}`}></span>{/if}
          {#if p.files}<span class="bg-ring" style={`flex:${p.files}`}></span>{/if}
          {#if p.search}<span class="bg-[#ff8a5b]" style={`flex:${p.search}`}></span>{/if}
        </span>
        <span class="text-right font-mono text-[12px] text-muted-foreground">{fmt(n)} lookups · {Math.round((p.map / n) * 100)}% map</span>
      </button>
    {:else}
      <p class="text-[13px] text-muted-foreground">No lookups were logged this {word}.</p>
    {/each}
  </Section>
</div>
