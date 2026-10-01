<script lang="ts">
  import type { SettingRow, SettingsTab } from "../../shared/tabs";
  import { store } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";

  let { settings }: { settings: SettingsTab } = $props();

  /** What the number boxes hold while being typed in, by key. */
  let drafts = $state<Record<string, string>>({});

  const fmt = (n: number) => n.toLocaleString("en-US");
  const locked = (r: SettingRow) => r.source === "env";
  const changed = (r: SettingRow) => r.source === "file" && r.value !== r.default;

  const dropDraft = (key: string) =>
    (drafts = Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== key)));

  /** Save a number box when it holds a new, valid value. */
  function commit(r: SettingRow): void {
    const raw = drafts[r.key];
    if (raw === undefined) return;
    dropDraft(r.key);
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n === r.value) return;
    store.setSetting(r.key, n);
  }

  function onkey(e: KeyboardEvent, r: SettingRow): void {
    const box = e.currentTarget as HTMLInputElement;
    if (e.key === "Enter") box.blur();
    if (e.key === "Escape") {
      dropDraft(r.key);
      box.blur();
    }
  }

  // The nudge is a number where 0 means off: shown as a switch plus a number,
  // and switching it back on restores the default.
  const isNudge = (r: SettingRow) => r.key === "memoryNudgeEvery";
</script>

<div class="hero">
  <Icon name="gear" size={26} class="syn" />
  <div class="stack">
    <span class="headline">Settings</span>
    <span class="small muted">
      Saved in <span class="mono">{settings.path}</span>, for every project, in any editor or terminal.
      An environment variable, when set, wins over this file.
    </span>
  </div>
</div>

{#each settings.groups as g (g.name)}
  <h2 class="section-label">{g.name}</h2>
  <div class="card">
    {#each g.rows as r (r.key)}
      {@const off = isNudge(r) && r.value === 0}
      <div class="row setting">
        <div class="stack">
          <span class="label">{r.label}</span>
          <span class="small muted">{r.help}</span>
          {#if locked(r)}
            <span class="small note">
              Set by <span class="mono">{r.env}</span> in your environment, so it can't be changed here.
            </span>
          {/if}
          {#if store.settingErrors[r.key]}
            <span class="stale">{store.settingErrors[r.key]}</span>
          {/if}
        </div>

        <div class="control">
          {#if r.type === "boolean" || isNudge(r)}
            {@const on = r.type === "boolean" ? r.value === true : !off}
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={r.label}
              class="switch"
              class:on
              disabled={locked(r) || store.saving[r.key]}
              onclick={() =>
                store.setSetting(
                  r.key,
                  r.type === "boolean" ? !on : on ? 0 : (r.default as number),
                )}
            >
              <span class="knob"></span>
            </button>
          {/if}
          {#if r.type === "number" && !off}
            <label class="num">
              {#if isNudge(r)}<span class="small muted">every</span>{/if}
              <input
                type="number"
                min={r.min}
                max={r.max}
                value={drafts[r.key] ?? String(r.value)}
                disabled={locked(r) || store.saving[r.key]}
                aria-label="{r.label} ({r.unit ?? ''})"
                oninput={(e) => (drafts = { ...drafts, [r.key]: e.currentTarget.value })}
                onblur={() => commit(r)}
                onkeydown={(e) => onkey(e, r)}
              />
              {#if r.unit}<span class="small muted">{r.unit}</span>{/if}
            </label>
          {/if}
          <span class="small status">
            {#if store.saving[r.key]}
              <span class="muted">Saving…</span>
            {:else if changed(r) && !locked(r)}
              <button type="button" class="link-btn" onclick={() => store.setSetting(r.key, null)}>
                Reset to {typeof r.default === "number" ? fmt(r.default) : r.default ? "on" : "off"}
              </button>
            {:else if r.type === "number"}
              <span class="muted">{fmt(r.min ?? 0)}–{fmt(r.max ?? 0)}</span>
            {/if}
          </span>
        </div>
      </div>
    {/each}
  </div>
{/each}

<p class="empty">
  Learning and Curator settings will appear here when those features arrive.
</p>

<style>
  .hero :global(.syn) {
    color: var(--syn);
  }
  .setting {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 10px 24px;
    padding: 12px 14px;
  }
  .setting .stack {
    flex: 1 1 320px;
  }
  .label {
    font-weight: 600;
  }
  .note {
    color: var(--warning);
  }
  .control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    min-width: 220px;
  }
  .num {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .num input {
    box-sizing: border-box;
    width: 88px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--input-border);
    border-radius: 5px;
    outline: none;
    background: var(--input);
    color: var(--input-fg);
    font: inherit;
  }
  .num input:focus {
    border-color: var(--focus);
  }
  .num input:disabled {
    opacity: 0.6;
  }
  .status {
    flex-basis: 100%;
  }
  /* A switch drawn with theme tokens: track, and a knob that moves. */
  .switch {
    position: relative;
    flex-shrink: 0;
    width: 34px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--input-border);
    border-radius: 9px;
    background: var(--input);
    cursor: pointer;
  }
  .switch.on {
    border-color: var(--focus);
    background: var(--focus);
  }
  .switch:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--fg);
    transition: left 0.12s;
  }
  .switch.on .knob {
    left: 18px;
    background: var(--vscode-button-foreground, #fff);
  }
</style>
