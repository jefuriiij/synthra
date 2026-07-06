<script lang="ts">
  // Card-shaped loading placeholder — mirrors Card's shell so the bento grid
  // holds its layout while the first /data poll is in flight.
  let { class: cls = "" }: { class?: string } = $props();
</script>

<div class={"animate-pulse rounded-xl border bg-card/40 " + cls}>
  <div class="flex h-full flex-col gap-3 p-4">
    <div class="h-3 w-24 rounded bg-muted/60"></div>
    <div class="h-7 w-32 rounded bg-muted/40"></div>
    <div class="h-3 w-full max-w-[240px] rounded bg-muted/25"></div>
  </div>
</div>
