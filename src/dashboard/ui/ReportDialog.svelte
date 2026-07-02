<script lang="ts">
  import { Dialog } from "bits-ui";
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import { store } from "$lib/store.svelte";

  let { open = $bindable(false) }: { open: boolean } = $props();
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const ISSUES = "https://github.com/jefuriiij/synthra/issues/new";
  const ICON: Record<string, string> = { ok: "✅", warn: "⚠️", fail: "❌" };

  // Re-run the checks every time the dialog opens — doctor state changes
  // (e.g. jq was just installed, a scan just ran).
  $effect(() => {
    if (open) void store.loadReport();
  });

  async function copyReport() {
    if (!store.report) return;
    try {
      await navigator.clipboard.writeText(store.report.markdown);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/60" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-card p-6 text-card-foreground shadow-2xl"
    >
      <Dialog.Title class="font-serif text-2xl">Report</Dialog.Title>
      <Dialog.Description class="text-xs text-muted-foreground">
        Your setup, checked live — copy the diagnostic into a bug report, or suggest an idea.
      </Dialog.Description>

      {#if store.reportLoading && !store.report}
        <div class="mt-4 text-sm text-muted-foreground">Running checks…</div>
      {:else if store.report}
        <div class="mt-3 font-mono text-xs text-muted-foreground">
          Synthra v{store.report.version} · {store.report.platform}
          {store.report.arch} · Node v{store.report.node}
        </div>
        <div class="mt-3 flex flex-col gap-1.5">
          {#each store.report.checks as c (c.label)}
            <div class="flex items-baseline gap-2 rounded-lg border bg-card/50 px-3 py-2">
              <span class="shrink-0">{ICON[c.status] ?? "•"}</span>
              <span class="shrink-0 font-mono text-sm text-foreground">{c.label}</span>
              <span class="min-w-0 text-[13px] leading-snug text-muted-foreground">{c.detail}</span>
            </div>
          {/each}
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button
            onclick={copyReport}
            class="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
          >
            {#if copied}
              <Check class="size-3.5" style="color: var(--c-fable)" /> Copied
            {:else}
              <Copy class="size-3.5" /> Copy report
            {/if}
          </button>
          <a
            href={`${ISSUES}?template=bug_report.yml`}
            target="_blank"
            rel="noreferrer"
            class="rounded-md border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
          >
            Report a bug ↗
          </a>
          <a
            href={`${ISSUES}?template=feature_request.yml`}
            target="_blank"
            rel="noreferrer"
            class="rounded-md border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
          >
            Suggest a feature ↗
          </a>
        </div>
        <p class="mt-3 text-xs leading-relaxed text-muted-foreground">
          Nothing is sent automatically — copy the report and paste it into the issue. Paths are
          redacted (your home directory shows as <code>~</code>).
        </p>
      {:else}
        <div class="mt-4 text-sm text-muted-foreground">
          Couldn't reach the dashboard server for the checks — you can still run
          <code class="text-foreground">syn doctor --report</code> in a terminal.
        </div>
      {/if}

      <Dialog.Close
        class="mt-4 w-full rounded-md border py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Close
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
