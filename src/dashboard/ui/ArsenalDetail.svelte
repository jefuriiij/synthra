<script lang="ts">
  // Full source for one arsenal item, centered over the browser. ONE instance
  // lives in Arsenal.svelte and follows the selected card — not one per card:
  // the grid re-renders on every filter keystroke, and 60 Dialog.Roots would
  // mean 60 portal/escape/dismiss/scroll-lock subscriptions for a thing that is
  // by definition single-instance.
  //
  // The body is third-party file content (any installed skill or plugin), so it
  // renders as TEXT — never {@html}, which would be stored XSS into the same
  // origin that serves /report and /data.
  import { Dialog } from "bits-ui";
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import { bodyStats, detailRows, detailSubtitle } from "$lib/arsenal-detail";
  import { itemKind, scopeColor } from "$lib/arsenal-groups";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import { store } from "$lib/store.svelte";
  import type { ArsenalItem, ArsenalKind } from "$lib/types";

  let {
    open = $bindable(false),
    item,
    kind,
  }: { open: boolean; item: ArsenalItem | null; kind: ArsenalKind } = $props();

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  // Lazy-load whenever a card opens the modal (same shape as ReportDialog).
  $effect(() => {
    if (!open || !item) return;
    void store.loadArsenalDetail(kind, item);
  });

  const detail = $derived(store.arsenalDetail);
  const rows = $derived(detailRows(detail));
  const stats = $derived(bodyStats(detail?.body));
  const color = $derived(item ? scopeColor(itemKind(item)) : "var(--muted-foreground)");
  // Falls back to the badge word while the fetch is in flight, so the header
  // never reflows once the body lands.
  const subtitle = $derived(item ? detailSubtitle(item, detail) : "");

  async function copySource() {
    if (!detail?.body) return;
    try {
      await navigator.clipboard.writeText(detail.body);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => {
    if (!o) store.clearArsenalDetail();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/60" />
    <!-- flex-col + overflow-hidden (not overflow-y-auto): the header must stay
         put while a 400-line body scrolls under it. -->
    <Dialog.Content
      class="syn-arsenal-detail fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(860px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-card p-6 text-card-foreground shadow-2xl"
    >
      {#if item}
        <div class="syn-arsenal-detail-head shrink-0">
          <Dialog.Title class="font-serif text-2xl" style={`color:${color}`}>
            {item.name}
          </Dialog.Title>
          <Dialog.Description class="mt-0.5 break-all font-mono text-xs text-muted-foreground">
            {subtitle}
          </Dialog.Description>
          {#if detail?.description || item.description}
            <p class="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              {detail?.description || item.description}
            </p>
          {/if}
        </div>

        <!-- min-h-0 is load-bearing: without it this flex child refuses to
             shrink below its content and pushes the footer out of reach. -->
        <div class="syn-arsenal-detail-scroll mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          {#if store.arsenalDetailLoading && !detail}
            <Skeleton class="syn-arsenal-detail-skeleton h-24 w-full" />
            <Skeleton class="mt-2 h-48 w-full" />
          {:else if store.arsenalDetailError}
            <div class="syn-arsenal-detail-error text-sm leading-relaxed text-muted-foreground">
              Couldn't read this item's file — it may have moved since the last scan. Try
              <span class="text-foreground">↻ Rescan</span>.
            </div>
            {#if item.meta}
              <div class="mt-3 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground/80">
                {#each Object.entries(item.meta) as [k, v] (k)}
                  <div class="break-all"><span class="text-foreground/70">{k}:</span> {v}</div>
                {/each}
              </div>
            {/if}
          {:else if detail}
            {#if rows.length}
              <dl
                class="syn-arsenal-detail-meta grid grid-cols-[minmax(84px,auto)_1fr] gap-x-3 gap-y-1.5"
              >
                {#each rows as [k, v] (k)}
                  <dt
                    class="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
                  >
                    {k}
                  </dt>
                  <dd class="min-w-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                    {v}
                  </dd>
                {/each}
              </dl>
            {/if}

            {#if detail.body}
              <div
                class="mt-4 flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
              >
                <span>Source</span>
                <span class="normal-case tracking-normal">
                  {stats.lines} lines{detail.truncated ? " · truncated" : ""}
                </span>
              </div>
              <!-- No max-h/overflow here: exactly one scroll container in this
                   modal, or you get nested scrollbars inside 85vh. -->
              <pre
                class="syn-arsenal-detail-body mt-1.5 whitespace-pre-wrap break-words rounded-lg border bg-background/60 p-3 font-mono text-[12px] leading-relaxed text-muted-foreground"
                style="tab-size:2">{detail.body}</pre>
            {:else if detail.kind === "mcp"}
              <p class="text-[13px] leading-relaxed text-muted-foreground">
                A server registration, not a file — there's no source to show. Headers, env, and
                args are never read, so nothing secret reaches this dashboard.
              </p>
            {/if}
          {/if}
        </div>

        <div class="syn-arsenal-detail-foot mt-4 flex shrink-0 items-center gap-2">
          {#if detail?.body}
            <button
              onclick={copySource}
              class="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
            >
              {#if copied}
                <Check class="size-3.5" style="color: var(--c-fable)" /> Copied
              {:else}
                <Copy class="size-3.5" /> Copy source
              {/if}
            </button>
          {/if}
          <Dialog.Close
            class="flex-1 rounded-md border py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Close
          </Dialog.Close>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
