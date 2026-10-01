<script lang="ts">
  import type { LearningTab } from "../../shared/tabs";
  import { plural, relativeTime } from "../../shared/time";
  import { store } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";

  let { learning: l, now }: { learning: LearningTab; now: number } = $props();

  const SCOPE = { project: "this project", global: "all projects" } as const;
  const VERB = { create: "New skill", patch: "Improved", edit: "Rewrote", reject: "Rejected" } as const;

  const headline = $derived.by(() => {
    const parts = [
      l.newThisWeek ? `learned ${plural(l.newThisWeek, "new skill")}` : "",
      l.improvedThisWeek ? `improved ${plural(l.improvedThisWeek, "skill")}` : "",
    ].filter(Boolean);
    return parts.length ? `This week Synthra ${parts.join(" and ")}` : "No new skills this week";
  });

  /** Rows before "Show more". */
  const FIRST = 8;
  let all = $state(false);
  const recent = $derived(all ? l.recent : l.recent.slice(0, FIRST));
</script>

<div class="hero">
  <Icon name="sparkle" size={28} class="syn" />
  <div class="stack">
    <span class="headline">{headline}</span>
    <span class="small muted">
      {plural(l.learned.length, "skill")} written by Synthra in total
      {#if l.pending.length}· <strong>{l.pending.length} waiting for your OK</strong>{/if}
    </span>
  </div>
</div>

{#if l.pending.length}
  <h2 class="section-label">Waiting for your OK <span class="aside">· {l.pending.length}</span></h2>
  <div class="card">
    {#each l.pending as p (p.id)}
      <div class="row">
        <Icon name={p.stale ? "warning" : p.action === "create" ? "sparkle" : "pencil"} size={16} class={p.stale ? "warn icon" : "syn icon"} />
        <div class="stack">
          <span class="name-line">
            <span class="headline-sm">{VERB[p.action]}</span>
            <span class="mono">{p.name}</span>
            <span class="tag">{SCOPE[p.scope]}</span>
          </span>
          {#if p.description}<span class="small muted clamp2">{p.description}</span>{/if}
          {#if p.reason}<span class="small">Why: {p.reason}</span>{/if}
          {#if p.stale}
            <span class="stale">The skill changed since this was proposed, so it can't be applied safely. Reject it, and ask the AI again.</span>
          {/if}
          {#if store.answerErrors[p.id]}<span class="stale">{store.answerErrors[p.id]}</span>{/if}
          <span class="actions">
            <button type="button" class="btn primary" disabled={p.stale || store.answering[p.id]} onclick={() => store.answer(p.id, "approve")}>
              <Icon name="check" size={13} /> Approve
            </button>
            <button type="button" class="btn" disabled={store.answering[p.id]} onclick={() => store.answer(p.id, "reject")}>
              <Icon name="cross" size={13} /> Reject
            </button>
            <button type="button" class="link-btn small" onclick={() => store.open(p.diff)}>See the change</button>
            <span class="small muted">{relativeTime(p.at, now)}</span>
          </span>
        </div>
      </div>
    {/each}
  </div>
{/if}

<h2 class="section-label">Recent changes <span class="aside">· last 30 days</span></h2>
{#if l.recent.length === 0}
  <p class="empty">
    No skill changes yet. When Claude works out a repeatable workflow, it saves it as a skill{l.approval ? ", and it waits here for your OK" : ""}.
  </p>
{:else}
  <div class="card">
    {#each recent as e (e.id)}
      <div class="row">
        <Icon name={e.action === "reject" ? "cross" : e.action === "create" ? "sparkle" : "pencil"} size={15} class={e.action === "create" ? "syn icon" : "muted icon"} />
        <div class="stack">
          <span class="name-line">
            <span class="headline-sm">{VERB[e.action]}</span>
            <span class="mono">{e.name}</span>
            <span class="tag">{SCOPE[e.scope]}</span>
          </span>
          {#if e.reason}<span class="small muted">Why: {e.reason}</span>{/if}
          <span class="small">
            <span class="muted">{relativeTime(e.at, now)}{e.approved ? " · you approved it" : ""}</span>
            {#if e.key}
              · <button type="button" class="link-btn" onclick={() => store.open(e.key)}>see the change</button>
            {/if}
          </span>
        </div>
      </div>
    {/each}
    {#if l.recent.length > FIRST}
      <button type="button" class="row-btn small link" onclick={() => (all = !all)}>
        {all ? "Show fewer" : `Show ${l.recent.length - FIRST} more`}
      </button>
    {/if}
  </div>
{/if}

{#if l.learned.length}
  <h2 class="section-label">Skills Synthra wrote <span class="aside">· {l.learned.length}</span></h2>
  <div class="card">
    {#each l.learned as s (s.scope + s.name)}
      <button type="button" class="row-btn" title="Open its SKILL.md" onclick={() => store.open(s.key)}>
        <Icon name="book" size={15} class="muted icon" />
        <span class="stack">
          <span class="name-line">
            <span class="mono">{s.name}</span>
            <span class="tag">{SCOPE[s.scope]}</span>
            {#if s.origin}<span class="small muted">learned in {s.origin}</span>{/if}
          </span>
          {#if s.description}<span class="small muted clamp2">{s.description}</span>{/if}
        </span>
      </button>
    {/each}
  </div>
{/if}

<p class="empty">
  {l.approval
    ? "New and changed skills wait for your OK. Change that in Settings."
    : "Skills go live at once (approval is off in Settings). Every change is still listed here."}
</p>

<style>
  .hero :global(.syn),
  .row :global(.syn) {
    color: var(--syn);
  }
  .row :global(.icon),
  .row-btn :global(.icon) {
    margin-top: 2px;
  }
  .row :global(.warn) {
    color: var(--warning);
  }
  .name-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
  }
  .headline-sm {
    font-weight: 600;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-top: 6px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--vscode-button-border, var(--input-border));
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--fg));
    cursor: pointer;
  }
  .btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--hover));
  }
  .btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .link {
    color: var(--link);
  }
</style>
