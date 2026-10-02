<script lang="ts">
  import type { LearningTab } from "../../shared/tabs";
  import { plural, relativeTime } from "../../shared/time";
  import { store } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";

  let { learning: l, now }: { learning: LearningTab; now: number } = $props();

  const SCOPE = { project: "this project", global: "all projects" } as const;
  const VERB = {
    create: "New skill",
    patch: "Improved",
    edit: "Rewrote",
    reject: "Rejected",
    archive: "Archive",
    restore: "Restored",
  } as const;
  const BY = { agent: "", user: " · by you", curator: " · by the Curator" } as const;

  const c = $derived(l.curator);
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

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
        <Icon name={p.stale ? "warning" : p.action === "create" ? "sparkle" : p.action === "archive" ? "history" : "pencil"} size={16} class={p.stale ? "warn icon" : "syn icon"} />
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
            <span class="muted">{relativeTime(e.at, now)}{BY[e.actor]}{e.approved ? " · you approved it" : ""}</span>
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

{#if c}
  <h2 class="section-label">Curator</h2>
  <div class="card">
    <div class="row curator-head">
      <div class="stack">
        <span class="name-line">
          <span class="dot" class:on={c.enabled}></span>
          <span class="headline-sm">{c.enabled ? "On · weekly" : "Off"}</span>
          <span class="small muted">· tidies the skills Synthra wrote</span>
        </span>
        <span class="grid small">
          <span><span class="muted">Last run</span><br />{c.lastRun}</span>
          {#if c.nextRunAt !== undefined}
            <span><span class="muted">Next run</span><br />{c.nextRunAt <= now ? "due — when Synthra is running" : `from ${day(c.nextRunAt)}`}</span>
          {/if}
        </span>
        <span class="small muted">
          Unused {c.staleDays} days → stale. Unused {c.archiveDays} days → archived{l.approval ? ", after your OK" : ""}. Nothing is deleted; pinned skills are never touched.
        </span>
        {#if store.curatorErrors.run}<span class="stale">{store.curatorErrors.run}</span>{/if}
      </div>
      <button type="button" class="btn" disabled={store.curatorBusy.run} onclick={() => store.curator({ type: "runCurator" })}>
        {store.curatorBusy.run ? "Running…" : "Run now"}
      </button>
    </div>
    {#each c.stale as s (s.path)}
      <div class="row">
        <Icon name="history" size={15} class="warn icon" />
        <div class="stack">
          <span class="name-line">
            <button type="button" class="link-btn mono" onclick={() => store.open(s.key)}>{s.name}</button>
            <span class="tag">{SCOPE[s.scope]}</span>
            <span class="small muted">stale · unused {s.daysUnused} days</span>
          </span>
          {#if store.curatorErrors[s.path]}<span class="stale">{store.curatorErrors[s.path]}</span>{/if}
        </div>
        <button type="button" class="btn" disabled={store.curatorBusy[s.path]} onclick={() => store.curator({ type: "pin", path: s.path, on: true })}>Pin</button>
      </div>
    {/each}
    {#each c.archived as a (a.archivePath)}
      <div class="row">
        <Icon name="book" size={15} class="muted icon" />
        <div class="stack">
          <span class="name-line">
            <button type="button" class="link-btn mono" onclick={() => store.open(a.key)}>{a.name}</button>
            <span class="tag">{SCOPE[a.scope]}</span>
            <span class="small muted">archived {relativeTime(a.at, now)}</span>
          </span>
          {#if store.curatorErrors[a.archivePath]}<span class="stale">{store.curatorErrors[a.archivePath]}</span>{/if}
        </div>
        <button type="button" class="btn" disabled={store.curatorBusy[a.archivePath]} onclick={() => store.curator({ type: "restore", archivePath: a.archivePath })}>Restore</button>
      </div>
    {/each}
    {#each c.pinned as p (p.path)}
      <div class="row">
        <Icon name="check" size={15} class="muted icon" />
        <div class="stack">
          <span class="name-line">
            <button type="button" class="link-btn mono" onclick={() => store.open(p.key)}>{p.name}</button>
            <span class="tag">{SCOPE[p.scope]}</span>
            <span class="small muted">pinned — the Curator leaves it alone</span>
          </span>
        </div>
        <button type="button" class="link-btn small" disabled={store.curatorBusy[p.path]} onclick={() => store.curator({ type: "pin", path: p.path, on: false })}>Unpin</button>
      </div>
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
  .curator-head {
    align-items: flex-start;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    margin: 6px 0;
  }
  .dot {
    background: var(--muted);
  }
  .dot.on {
    background: var(--success);
  }
</style>
