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

<!--
  Bento: full-width metric strip · a 2-col block of equal-height cards (left)
  beside a tall Moat (right) · full-width recent turns.
  The left cards size to their own content (cards in a grid row equalize height).
  The Moat spans those three rows, but its content is absolutely positioned
  (lg+) so it never inflates the rows — it just fills the spanned cell and
  scrolls internally. That keeps Savings / Total Spend at their content height.
-->
<div class="grid grid-cols-1 gap-4 p-5 lg:grid-cols-3">
  <div class="lg:col-span-3 lg:row-start-1"><MetricStrip /></div>

  <div class="lg:col-start-1 lg:row-start-2"><Savings /></div>
  <div class="lg:col-start-2 lg:row-start-2"><CostHero /></div>

  <div class="lg:col-start-1 lg:row-start-3"><Donut /></div>
  <div class="lg:col-start-2 lg:row-start-3"><HotFiles /></div>

  <div class="lg:col-start-1 lg:row-start-4"><Projects /></div>
  <div class="lg:col-start-2 lg:row-start-4"><ToolUsage /></div>

  <div class="relative lg:col-start-3 lg:row-start-2 lg:row-span-3">
    <div class="lg:absolute lg:inset-0"><Moat /></div>
  </div>

  <div class="lg:col-span-3 lg:row-start-5"><RecentTurns /></div>
</div>
