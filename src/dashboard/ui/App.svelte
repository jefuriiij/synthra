<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "$lib/store.svelte";
  import TopBar from "./TopBar.svelte";
  import Overview from "./Overview.svelte";
  import FaqDialog from "./FaqDialog.svelte";
  import ReportDialog from "./ReportDialog.svelte";

  let faqOpen = $state(false);
  let reportOpen = $state(false);

  onMount(() => {
    store.start();
    return () => store.stop();
  });
</script>

<div class="syn-app min-h-screen">
  <TopBar onFaq={() => (faqOpen = true)} onReport={() => (reportOpen = true)} />
  <main class="syn-main">
    <Overview />
  </main>
</div>

<FaqDialog bind:open={faqOpen} />
<ReportDialog bind:open={reportOpen} />
