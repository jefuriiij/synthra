<script lang="ts">
  import { store, samePath } from "$lib/store.svelte";
  import { CountUp } from "$lib/countup";
  import { fmt, fmtAgo, fmtCost, fmtTs, modelLabel } from "$lib/format";
  import { HOOK_COLS, HOOKS_STATE_LABEL, behind } from "$lib/health";
  import Section from "./Section.svelte";
  import FindingCode from "./FindingCode.svelte";
  import MissedCard from "./MissedCard.svelte";
  import LearningCard from "./LearningCard.svelte";
  import MemoryCard from "./MemoryCard.svelte";

  const o = $derived(store.overview);
  const p = $derived(o?.project);
  const h = $derived(o?.health.find((x) => p && samePath(x.path, p.path)));
  const mine = $derived(o?.this_project);
  const total = $derived(o?.cost.spend ?? 0);
  const word = $derived(store.days === 30 ? "month" : "week");
  const isHome = $derived(!!o?.home && !!p && samePath(o.home.path, p.path));
  const share = $derived(total > 0 && mine ? Math.round((mine.cost.spend / total) * 100) : 0);
  const spend = new CountUp();
  $effect(() => spend.set(mine?.cost.spend ?? 0));
  const models = [
    { key: "opus", label: "Opus", color: "var(--c-opus)" },
    { key: "sonnet", label: "Sonnet", color: "var(--c-sonnet)" },
    { key: "fable", label: "Fable", color: "var(--c-fable)" },
    { key: "haiku", label: "Haiku", color: "var(--c-haiku)" },
    { key: "other", label: "Other", color: "var(--c-unknown)" },
  ];
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-2.5 py-0.5 font-mono text-[12px] text-muted-foreground";
</script>

{#if p}
  <div class="mb-5 flex flex-wrap items-end gap-x-4 gap-y-2">
    <h1 class="font-serif text-[40px] font-normal leading-none">{p.name}</h1>
    <div class="flex flex-wrap gap-1.5 pb-1">
      <span class={chip + " max-w-[46ch] truncate"} title={p.path}>{p.path}</span>
      {#if isHome}<span class={chip + " text-ring"}>this window</span>{/if}
      {#if h?.version}<span class={chip}>Synthra {h.version}</span>{/if}
      {#if h}
        <span class={chip + (h.hooks_state === "current" || h.hooks_state === "newer" ? " text-money" : " text-sonnet")}>
          <span class={"size-1.5 rounded-full " + (h.hooks_state === "current" || h.hooks_state === "newer" ? "bg-money" : "bg-sonnet")}></span>
          {HOOKS_STATE_LABEL[h.hooks_state]}
        </span>
      {/if}
    </div>
  </div>

  <div class="grid grid-cols-12 gap-4">
    {#if h?.problem}
      <div class="col-span-12 flex items-center gap-4 rounded-2xl border border-sonnet/30 bg-sonnet/5 px-5 py-4">
        <p class="flex-1 text-[14px]"><b>Needs a look:</b> {h.problem}</p>
        {#if h.fix === "hooks"}
          <button onclick={() => store.fixHooks([h.path])} disabled={store.fixing !== null} class="whitespace-nowrap rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground disabled:opacity-60">
            {store.fixing === h.path ? "Fixing…" : "Fix hooks"}
          </button>
        {/if}
      </div>
    {:else if h?.note}
      <div class="col-span-12 rounded-2xl border border-border bg-secondary/40 px-5 py-3.5 text-[13.5px] text-muted-foreground">{h.note}</div>
    {/if}
    {#if store.fixed}
      <p class={"col-span-12 text-[13px] " + (store.fixed.ok ? "text-money" : "text-destructive")}>{store.fixed.text}</p>
    {/if}

    <Section class="col-span-12" title="Is it working?" sub="When each part last ran here" why="A part that stops quietly is the worst kind of bug. This catches it.">
      {#if h}
        <div class="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
          {#each HOOK_COLS as c (c.key)}
            {@const t = h.hooks[c.key]}
            {@const late = behind(h, c.key)}
            <div class={"rounded-xl border bg-secondary/40 px-3.5 py-3 " + (late ? "border-sonnet/40" : "border-border")}>
              <div class="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground/70">{c.label}</div>
              <div class={"mt-1.5 flex items-center gap-2 font-mono text-[15px] " + (late ? "text-sonnet" : "")}>
                <span class={"size-2 rounded-full " + (late ? "bg-sonnet" : t ? "bg-money" : "bg-muted-foreground/40")}></span>
                {!t && c.key === "start" ? "not yet" : fmtAgo(t)}
              </div>
            </div>
          {/each}
          <div class="rounded-xl border border-border bg-secondary/40 px-3.5 py-3">
            <div class="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground/70">Map</div>
            <div class="mt-1.5 font-mono text-[15px]">{h.map_built_at ? `built ${fmtAgo(h.map_built_at)}` : "not built"}</div>
          </div>
        </div>
      {:else}
        <p class="text-[13px] text-muted-foreground">Synthra hasn't run here yet.</p>
      {/if}
    </Section>

    <Section class="col-span-12 xl:col-span-8" title="Is it helping?" sub="How Claude found code here" why="The more Claude uses the map, the fewer tokens it spends reading. This is the number to push up.">
      <FindingCode finding={mine?.finding} />
    </Section>
    <Section class="col-span-12 xl:col-span-4">
      <MissedCard finding={mine?.finding} />
    </Section>

    <Section class="col-span-12 lg:col-span-6 2xl:col-span-4" title="Learning" sub="Skills Claude wrote, here and global" why="Are skills written, kept and actually used?">
      <LearningCard />
    </Section>
    <Section class="col-span-12 lg:col-span-6 2xl:col-span-4" title="Memory" sub="What Claude keeps in mind" why="Is memory kept short, current and used?">
      <MemoryCard />
    </Section>
    <Section class="col-span-12 2xl:col-span-4" title="Cost" sub="This project, at API prices" why={total > 0 ? `${share}% of all your spend this ${word}.` : undefined}>
      {@const c = mine?.cost}
      <div class="font-mono text-[34px] font-medium leading-none text-money">{fmtCost(spend.value)}</div>
      <div class="mt-1.5 text-[13px] text-muted-foreground">
        {fmt(c?.replies ?? 0)} replies{#if c && c.replies > 0} · {fmtCost(c.spend / c.replies)} a reply{/if}
      </div>
      {#if c?.codex && c.codex.replies > 0}
        <div class="mt-1 text-[13px] text-muted-foreground" title="Codex is a flat plan, so its replies aren't in the cost.">
          Codex: {fmt(c.codex.replies)} replies · {fmt(c.codex.tokens)} tokens{#if c.codex.fiveHour !== undefined} · {Math.round(c.codex.fiveHour)}% of the 5-hour limit{/if}{#if c.codex.week !== undefined} · {Math.round(c.codex.week)}% of the week{/if}
        </div>
      {/if}
      {#if c && c.spend > 0}
        <div class="mb-2 mt-4 flex h-2 gap-[2px] overflow-hidden rounded-full">
          {#each models as m (m.key)}
            {#if (c.models[m.key] ?? 0) > 0}<div style={`flex:${c.models[m.key]};background:${m.color}`}></div>{/if}
          {/each}
        </div>
        <div class="flex flex-wrap gap-4 text-[13px] text-muted-foreground">
          {#each models.filter((m) => (c.models[m.key] ?? 0) > 0) as m (m.key)}
            <span><i class="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]" style={`background:${m.color}`}></i>{m.label} {Math.round(((c.models[m.key] ?? 0) / c.spend) * 100)}%</span>
          {/each}
        </div>
      {/if}
      <div class="mt-5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Most expensive replies</div>
      {#each c?.priciest ?? [] as r, i (i)}
        <div class="grid grid-cols-[1fr_auto] border-b border-border py-2 text-[13px]">
          <span class="font-mono text-xs text-muted-foreground/80">{fmtTs(r.ts)} · {modelLabel(r.model)}</span>
          <span class="font-mono text-money">{fmtCost(r.cost)}</span>
        </div>
      {:else}
        <p class="mt-2 text-[13px] text-muted-foreground">No replies this {word}.</p>
      {/each}
    </Section>
  </div>
{/if}
