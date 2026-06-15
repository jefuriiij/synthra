<script lang="ts">
  import MetricStrip from "./MetricStrip.svelte";
  import Savings from "./Savings.svelte";
  import CostHero from "./CostHero.svelte";
  import Donut from "./Donut.svelte";
  import Projects from "./Projects.svelte";
  import ToolUsage from "./ToolUsage.svelte";
  import RecentTurns from "./RecentTurns.svelte";
  import Moat from "./Moat.svelte";
  import HotFiles from "./HotFiles.svelte";
</script>

<div class="flex flex-col gap-4 p-5">
  <MetricStrip />
  <div class="grid grid-cols-12 gap-4">
    <div class="col-span-12 lg:col-span-7"><Savings /></div>
    <div class="col-span-12 lg:col-span-5"><CostHero /></div>

    <div class="col-span-12 md:col-span-6 xl:col-span-4"><Donut /></div>
    <div class="col-span-12 md:col-span-6 xl:col-span-4"><Projects /></div>
    <div class="col-span-12 xl:col-span-4"><ToolUsage /></div>

    <div class="col-span-12 xl:col-span-8"><RecentTurns /></div>
    <div class="col-span-12 flex flex-col gap-4 xl:col-span-4">
      <Moat />
      <HotFiles />
    </div>
  </div>
</div>
