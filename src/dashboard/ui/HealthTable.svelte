<script lang="ts">
  import { store } from "$lib/store.svelte";
  import { fmtAgo } from "$lib/format";
  import type { ProjectHealth } from "$lib/types";

  const cols: { key: "start" | "tools" | "reply" | "prompt"; label: string }[] = [
    { key: "start", label: "Session start" },
    { key: "tools", label: "Tool checks" },
    { key: "reply", label: "Replies" },
    { key: "prompt", label: "Prompts" },
  ];
  const DAY = 24 * 60 * 60 * 1000;

  /** A hook is behind when it never ran, or ran a week or more before the
   *  project's newest hook, while the others kept going. "start" is only
   *  recorded from 0.34 on, so a missing one says nothing. */
  function behind(h: ProjectHealth, key: string, iso: string | undefined): boolean {
    const times = Object.values(h.hooks).map((t) => Date.parse(t ?? "")).filter(Number.isFinite);
    if (times.length === 0) return false;
    if (!iso) return key !== "start";
    return Math.max(...times) - Date.parse(iso) >= 7 * DAY;
  }
  const label = (key: string, iso: string | undefined) => (!iso && key === "start" ? "not yet" : fmtAgo(iso));

  const stateLabel: Record<ProjectHealth["hooks_state"], string> = {
    current: "hooks up to date",
    outdated: "hooks out of date",
    missing: "no hooks",
    newer: "hooks from a newer Synthra",
  };
</script>

<div class="rounded-xl border border-border bg-card/70 px-5 py-4">
  {#if (store.overview?.health ?? []).length === 0}
    <p class="text-sm text-muted-foreground">No project yet.</p>
  {:else}
    <table class="w-full border-collapse text-[13.5px]">
      <thead>
        <tr class="text-left font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground/70">
          <th class="pb-2.5 font-medium">Project</th>
          {#each cols as c (c.key)}<th class="pb-2.5 font-medium">{c.label}</th>{/each}
          <th class="pb-2.5 font-medium">Map</th>
        </tr>
      </thead>
      <tbody>
        {#each store.overview?.health ?? [] as h (h.path)}
          <tr class="border-t border-border">
            <td class="py-2.5 pr-3">
              <div class="font-medium text-foreground">{h.name}</div>
              <div class={"font-mono text-xs " + (h.hooks_state === "current" || h.hooks_state === "newer" ? "text-muted-foreground/70" : "text-sonnet")}>
                {h.version ? `Synthra ${h.version} · ` : ""}{stateLabel[h.hooks_state]}
              </div>
            </td>
            {#each cols as c (c.key)}
              {@const t = h.hooks[c.key]}
              {@const late = behind(h, c.key, t)}
              <td class="py-2.5 pr-3">
                <span class={"inline-flex items-center gap-2 font-mono text-[12.5px] " + (late ? "text-sonnet" : "text-muted-foreground")}>
                  <span class={"size-2 rounded-full " + (late ? "bg-sonnet" : t ? "bg-money" : "bg-muted-foreground/40")}></span>
                  {label(c.key, t)}
                </span>
              </td>
            {/each}
            <td class="py-2.5 font-mono text-[12.5px] text-muted-foreground">
              {h.map_built_at ? `built ${fmtAgo(h.map_built_at)}` : "not built"}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#each (store.overview?.health ?? []).filter((h) => h.problem) as h (h.path)}
      <div class="mt-3 flex items-center gap-3.5 rounded-lg border border-sonnet/30 bg-sonnet/5 px-3.5 py-3">
        <p class="flex-1 text-[13.5px] text-foreground/85"><b>{h.name}:</b> {h.problem}</p>
        {#if h.fix === "hooks"}
          <button
            onclick={() => store.fixHooks([h.path])}
            disabled={store.fixing !== null}
            class="whitespace-nowrap rounded-lg border border-border bg-secondary px-3.5 py-1.5 text-[13px] font-medium disabled:opacity-60"
          >
            {store.fixing === h.path ? "Fixing…" : "Fix hooks"}
          </button>
        {/if}
      </div>
    {/each}

    {#each (store.overview?.health ?? []).filter((h) => h.note) as h (h.path)}
      <div class="mt-3 rounded-lg border border-border bg-secondary/40 px-3.5 py-3 text-[13.5px] text-muted-foreground">
        <b class="text-foreground">{h.name}:</b> {h.note}
      </div>
    {/each}

    {#if store.fixed}
      <p class={"mt-3 text-[13px] " + (store.fixed.ok ? "text-money" : "text-destructive")}>{store.fixed.text}</p>
    {/if}
    <p class="mt-3 text-xs text-muted-foreground/70">
      "Session start" shows from Synthra 0.34 on. Before that, the other columns come from the logs each part writes.
    </p>
  {/if}
</div>
