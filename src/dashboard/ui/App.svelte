<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "$lib/store.svelte";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import TopBar from "./TopBar.svelte";
  import Sidebar from "./Sidebar.svelte";
  import AllView from "./AllView.svelte";
  import ProjectView from "./ProjectView.svelte";
  import FaqDialog from "./FaqDialog.svelte";
  import ReportDialog from "./ReportDialog.svelte";

  let faqOpen = $state(false);
  let reportOpen = $state(false);

  onMount(() => {
    store.start();
    return () => store.stop();
  });
</script>

<!--
  One dashboard for every project: any window's dashboard lists every project
  Synthra knows on the left, and shows all of them or one of them on the
  right, across the full width of the window.
-->
<div class="syn-app min-h-screen">
  <TopBar onFaq={() => (faqOpen = true)} onReport={() => (reportOpen = true)} />
  <div class="grid min-h-[calc(100vh-57px)] grid-cols-1 md:grid-cols-[272px_minmax(0,1fr)]">
    <!-- The column keeps its colour the whole page down; the list inside it
         stays in view while the page scrolls. -->
    <aside class="border-b border-sidebar-border bg-sidebar/80 md:border-b-0 md:border-r">
      <div class="px-3 py-4 md:sticky md:top-[57px] md:max-h-[calc(100vh-57px)] md:overflow-y-auto">
        {#if store.overview}
          <Sidebar />
        {:else}
          <div class="flex flex-col gap-2">
            <Skeleton class="h-12" />
            <Skeleton class="h-10" />
            <Skeleton class="h-10" />
          </div>
        {/if}
      </div>
    </aside>
    <main class="syn-main min-w-0 px-4 pb-16 pt-6 sm:px-6 lg:px-8">
      {#if !store.showing}
        <div class="grid grid-cols-12 gap-4">
          <Skeleton class="col-span-12 h-16" />
          <Skeleton class="col-span-12 h-40" />
          <Skeleton class="col-span-12 h-64 xl:col-span-8" />
          <Skeleton class="col-span-12 h-64 xl:col-span-4" />
        </div>
      {:else}
        <div class="duration-300 animate-in fade-in">
          {#if store.route.kind === "all"}
            <AllView />
          {:else}
            <ProjectView />
          {/if}
        </div>
      {/if}
    </main>
  </div>
</div>

<FaqDialog bind:open={faqOpen} />
<ReportDialog bind:open={reportOpen} />
