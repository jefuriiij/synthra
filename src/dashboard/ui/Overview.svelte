<script lang="ts">
  import StatusBanner from "./StatusBanner.svelte";
  import Section from "./Section.svelte";
  import HealthTable from "./HealthTable.svelte";
  import FindingCode from "./FindingCode.svelte";
  import LearningCard from "./LearningCard.svelte";
  import MemoryCard from "./MemoryCard.svelte";
  import CostCard from "./CostCard.svelte";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import { store } from "$lib/store.svelte";
</script>

<!--
  The report card: is Synthra working, is it helping, what it learned and
  remembers, and what the work cost. Before the first poll lands, a skeleton
  holds the layout.
-->
<div class="mx-auto max-w-[1120px] px-7 pb-16 pt-6">
  {#if store.overview === null}
    <div class="flex flex-col gap-4">
      <Skeleton class="h-20" />
      <Skeleton class="h-48" />
      <Skeleton class="h-56" />
      <Skeleton class="h-72" />
    </div>
  {:else}
    <div class="duration-500 animate-in fade-in">
      <StatusBanner />

      <Section title="Is it working?" sub="When each part of Synthra last ran" why="A part that stops quietly is the worst kind of bug. This catches it.">
        <HealthTable />
      </Section>

      <Section title="Is it helping?" sub="How Claude found code" why="The more Claude uses the map, the fewer tokens it spends reading. This is the number to push up.">
        <FindingCode />
      </Section>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Learning" sub={`Skills Claude wrote · ${store.overview.project.name} and global`} why="Are skills written, kept and actually used?">
          <LearningCard />
        </Section>
        <Section title="Memory" sub={`What Claude keeps in mind · ${store.overview.project.name}`} why="Is memory kept short, current and used?">
          <MemoryCard />
        </Section>
      </div>

      <Section title="Cost" sub="At API prices, all projects">
        <CostCard />
      </Section>
    </div>
  {/if}
</div>
