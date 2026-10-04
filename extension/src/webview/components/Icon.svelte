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
    | "gear"
    | "learning"
    | "sparkle"
    | "pencil"
    | "check"
    | "cross"
    | "more"
    | "star"
    | "star-full"
    | "trash"
    | "merge"
    | "link"
    | "update"
    | "hold"
    | "diff"
    | "external";
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

{#if name === "sparkle"}
  <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
    <path d="M10 6Q10 14 18 14Q10 14 10 22Q10 14 2 14Q10 14 10 6Z" />
    <path opacity="0.75" d="M18.5 2Q18.5 5.5 22 5.5Q18.5 5.5 18.5 9Q18.5 5.5 15 5.5Q18.5 5.5 18.5 2Z" />
  </svg>
{:else if name === "star-full"}
  <svg class={cls} width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">
    <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
  </svg>
{:else if name === "more"}
  <svg class={cls} width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
{:else if name === "memory"}
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
    {:else if name === "learning"}
      <path d="M8 1.8Q8.6 7.4 14.2 8Q8.6 8.6 8 14.2Q7.4 8.6 1.8 8Q7.4 7.4 8 1.8Z" />
    {:else if name === "pencil"}
      <path d="M3 13l1-3 7-7 2 2-7 7z" />
    {:else if name === "check"}
      <path d="M3.5 8.5l3 3 6-7" stroke-width="1.7" />
    {:else if name === "cross"}
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-width="1.7" />
    {:else if name === "gear"}
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" />
      <circle cx="8" cy="8" r="4.6" />
    {:else if name === "star"}
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
    {:else if name === "trash"}
      <path d="M2.5 4.5h11M6 4.5V2.8h4v1.7M4 4.5l.7 9h6.6l.7-9M6.8 7v4.5M9.2 7v4.5" />
    {:else if name === "merge"}
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5v6M4 6c0 2 2.5 2 6.5 2" />
    {:else if name === "link"}
      <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.7.7M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7" />
    {:else if name === "update"}
      <path d="M8 2v8M4.8 7L8 10.2 11.2 7M2.5 11v2.5h11V11" />
    {:else if name === "hold"}
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    {:else if name === "diff"}
      <path d="M5 2v6M2 5h6M8.5 11.5h5.5M3 14L13 2" />
    {:else if name === "external"}
      <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4" />
    {:else if name === "robot"}
      <path d="M3.5 5.5h9v7h-9zM8 2.5v3M6 8.5v.5M10 8.5v.5M6.5 10.8h3M1.5 8v2.5M14.5 8v2.5" />
    {/if}
  </svg>
{/if}
