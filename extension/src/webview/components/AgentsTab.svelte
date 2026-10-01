<script lang="ts">
  import type { AgentsTab } from "../../shared/tabs";
  import { plural, relativeTime } from "../../shared/time";
  import Icon from "./Icon.svelte";

  let { agents, now }: { agents: AgentsTab; now: number } = $props();

  const top = $derived(agents.most[0]);
  const most = $derived(agents.most[0]?.count ?? 1);

  /** Rows before "Show all". */
  const FIRST = 15;
  let all = $state(false);
  const visible = $derived(all ? agents.recent : agents.recent.slice(0, FIRST));
</script>

<div class="hero">
  <Icon name="agents" size={26} class="syn" />
  <div class="stack">
    <span class="headline">
      {agents.recent.length === 0
        ? "Claude has not started a helper agent this week"
        : `Claude started ${plural(agents.recent.length, "helper agent")} this week`}
    </span>
    <span class="small muted">
      {top
        ? `Used most: ${top.agent} (${plural(top.count, "time")}). Synthra sees a helper when Claude finishes its reply.`
        : "When Claude hands a task to a helper agent, it shows here after Claude finishes its reply."}
    </span>
  </div>
</div>

{#if agents.recent.length > 0}
  <h2 class="section-label">Recent <span class="aside">· last 7 days</span></h2>
  <div class="card">
    {#each visible as a (a.id)}
      <div class="row">
        <Icon name="robot" size={15} class="muted icon" />
        <div class="stack">
          <span class="wrap">{a.title}</span>
          <span class="small muted">
            {[a.title !== a.agent ? a.agent : "", a.model ?? "", relativeTime(a.at, now)].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
    {/each}
    {#if agents.recent.length > FIRST}
      <button type="button" class="row-btn small link" onclick={() => (all = !all)}>
        {all ? "Show fewer" : `Show all ${agents.recent.length}`}
      </button>
    {/if}
  </div>

  <h2 class="section-label">Used most <span class="aside">· last 7 days</span></h2>
  <div class="card">
    {#each agents.most as m (m.agent)}
      <div class="row bar-row">
        <span class="mono agent">{m.agent}</span>
        <span class="track"><span class="fill" style="width: {Math.max(4, (m.count / most) * 100)}%"></span></span>
        <span class="small muted n">{m.count}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .hero :global(.syn) {
    color: var(--syn);
  }
  .row :global(.icon) {
    margin-top: 2px;
  }
  .bar-row {
    align-items: center;
  }
  .agent {
    width: 34%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track {
    flex: 1;
    height: 6px;
    overflow: hidden;
    border-radius: 3px;
    background: var(--card);
    border: 1px solid var(--border);
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--syn);
  }
  .n {
    width: 3ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .link {
    color: var(--link);
  }
</style>
