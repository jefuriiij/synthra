<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "$lib/store.svelte";
  import Sidebar from "./Sidebar.svelte";
  import Overview from "./Overview.svelte";
  import Arsenal from "./Arsenal.svelte";
  import FaqDialog from "./FaqDialog.svelte";

  let faqOpen = $state(false);

  onMount(() => {
    store.start();
    return () => store.stop();
  });
</script>

<div class="flex h-screen w-screen overflow-hidden">
  <Sidebar onFaq={() => (faqOpen = true)} />
  <main class="min-w-0 flex-1 overflow-y-auto">
    {#if store.view === "overview"}
      <Overview />
    {:else}
      <Arsenal />
    {/if}
  </main>
</div>

<FaqDialog bind:open={faqOpen} />
