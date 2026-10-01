<script lang="ts" module>
  export type IconName =
    | "memory"
    | "capabilities"
    | "agents"
    | "search"
    | "refresh"
    | "spin"
    | "chevron"
    | "person"
    | "package"
    | "plug"
    | "repo"
    | "file"
    | "warning"
    | "target"
    | "blocker"
    | "next"
    | "decision"
    | "fact"
    | "history"
    | "book"
    | "robot"
    | "gear";
</script>

<script lang="ts">
  // Line icons drawn in currentColor, so every theme (high contrast too)
  // colours them. Most come from Hermes Studio's PanelIcon.
  let {
    name,
    size = 16,
    class: cls = "",
  }: { name: IconName; size?: number; class?: string } = $props();
</script>

{#if name === "memory"}
  <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
  </svg>
{:else}
  <svg class={cls} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">
    {#if name === "capabilities"}
      <path d="M6 2.5h4v2a1.5 1.5 0 0 0 3 0V6h1.5v4h-2a1.5 1.5 0 0 0 0 3h2v1.5H10v-1.5a1.5 1.5 0 0 0-3 0v1.5H2.5V10H4a1.5 1.5 0 0 0 0-3H2.5V2.5z" />
    {:else if name === "agents"}
      <circle cx="8" cy="3.8" r="1.8" />
      <circle cx="3.8" cy="12.2" r="1.8" />
      <circle cx="12.2" cy="12.2" r="1.8" />
      <path d="M8 5.6V8M8 8l-3 2.7M8 8l3 2.7" />
    {:else if name === "search"}
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    {:else if name === "refresh"}
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" />
    {:else if name === "spin"}
      <circle cx="8" cy="8" r="5" opacity="0.3" />
      <path class="spin" d="M8 3a5 5 0 0 1 5 5" stroke-width="1.7" />
    {:else if name === "chevron"}
      <path d="M6 4l4 4-4 4" />
    {:else if name === "person"}
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c.6-2.8 2.6-4 5-4s4.4 1.2 5 4" />
    {:else if name === "package"}
      <path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5L8 7.5 13.5 5M8 7.5v6" />
    {:else if name === "plug"}
      <path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14" />
    {:else if name === "repo"}
      <path d="M3.5 2.5h8.5v9H4.75A1.25 1.25 0 0 0 3.5 12.75zM3.5 12.75A1.25 1.25 0 0 0 4.75 14H12v-2.5" />
    {:else if name === "file"}
      <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3" />
    {:else if name === "warning"}
      <path d="M8 2l6 11H2zM8 6.5v3M8 11.3v.2" />
    {:else if name === "target"}
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2.5" />
    {:else if name === "blocker"}
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    {:else if name === "next"}
      <path d="M3 8h9.5M9 4.5L12.5 8 9 11.5" />
    {:else if name === "decision"}
      <path d="M8 2v12M4.5 14h7M3 4.5h10M3 4.5L1.5 9a1.8 1.8 0 0 0 3 0zM13 4.5L11.5 9a1.8 1.8 0 0 0 3 0z" />
    {:else if name === "fact"}
      <path d="M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    {:else if name === "history"}
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.2h2.2M8 5v3.2l2 1.3" />
    {:else if name === "book"}
      <path d="M8 4c-1.5-1.2-3.5-1.5-5.5-1.2v9.5c2-.3 4 0 5.5 1.2 1.5-1.2 3.5-1.5 5.5-1.2V2.8C11.5 2.5 9.5 2.8 8 4zM8 4v9.5" />
    {:else if name === "gear"}
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" />
      <circle cx="8" cy="8" r="4.6" />
    {:else if name === "robot"}
      <path d="M3.5 5.5h9v7h-9zM8 2.5v3M6 8.5v.5M10 8.5v.5M6.5 10.8h3M1.5 8v2.5M14.5 8v2.5" />
    {/if}
  </svg>
{/if}
