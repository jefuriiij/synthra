<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "$lib/store.svelte";
  import Sidebar from "./Sidebar.svelte";
  import Overview from "./Overview.svelte";
  import Arsenal from "./Arsenal.svelte";
  import Commands from "./Commands.svelte";
  import FaqDialog from "./FaqDialog.svelte";
  import ReportDialog from "./ReportDialog.svelte";

  let faqOpen = $state(false);
  let reportOpen = $state(false);

  onMount(() => {
    store.start();
    return () => store.stop();
  });
</script>

<div class="flex h-screen w-screen overflow-hidden">
  <Sidebar onFaq={() => (faqOpen = true)} onReport={() => (reportOpen = true)} />
  <main class="min-w-0 flex-1 overflow-y-auto">
    {#if store.view === "overview"}
      <Overview />
    {:else if store.view === "commands"}
      <Commands />
    {:else}
      <Arsenal />
    {/if}
  </main>
</div>

<FaqDialog bind:open={faqOpen} />
<ReportDialog bind:open={reportOpen} />
