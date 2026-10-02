<script lang="ts">
  import Savings from "./Savings.svelte";
  import CostHero from "./CostHero.svelte";
  import Donut from "./Donut.svelte";
  import Projects from "./Projects.svelte";
  import ToolUsage from "./ToolUsage.svelte";
  import RecentTurns from "./RecentTurns.svelte";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import { store } from "$lib/store.svelte";

  // Saving is counted only from Grep/Glob searches the gate stopped. Claude
  // mostly searches through Bash now, which Synthra only watches, so a $0 card
  // would tell the wrong story. It shows once something was actually saved.
  const saved = $derived((store.data?.global?.blocked_count ?? 0) > 0);
</script>

<!--
  One page: what the work cost. Spend · models (and savings, once there are
  any) across the top, projects beside the Synthra tools Claude used, then
  every reply. Before the first /data poll lands, a skeleton grid holds the
  layout.
-->
{#if store.data === null}
  <div class="grid grid-cols-1 gap-4 p-5 lg:grid-cols-3">
    <Skeleton class="h-44" />
    <Skeleton class="h-44" />
    <Skeleton class="h-44" />
    <Skeleton class="h-40 lg:col-span-3" />
    <Skeleton class="h-36 lg:col-span-3" />
  </div>
{:else}
  <div class="syn-overview flex flex-col gap-4 p-5 duration-500 animate-in fade-in">
    <div class={"grid grid-cols-1 gap-4 " + (saved ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
      {#if saved}<Savings />{/if}
      <CostHero />
      <Donut />
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Projects />
      <ToolUsage />
    </div>

    <RecentTurns />
  </div>
{/if}
