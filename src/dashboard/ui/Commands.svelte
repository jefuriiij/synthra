<script lang="ts">
  // Static CLI reference — mirrors the sade registrations in src/cli/index.ts.
  // Keep the two in sync when commands change.
  interface Cmd {
    cmd: string;
    desc: string;
    opts?: { flag: string; desc: string }[];
  }
  const commands: Cmd[] = [
    {
      cmd: "syn . [path]",
      desc: "The default flow: scan the project, start the MCP server + dashboard, install the hooks, and register the MCP entry for the IDE. Runs as a background service — Ctrl+C stops it.",
      opts: [
        { flag: "--full", desc: "Re-parse every file, ignoring the incremental parse cache" },
        { flag: "--launch-cli", desc: "Also spawn the `claude` CLI in this terminal" },
        { flag: "--resume <id>", desc: "Resume a Claude session (requires --launch-cli)" },
      ],
    },
    {
      cmd: "syn scan [path]",
      desc: "Scan only — walk the project, parse it into the symbol graph, and write it to .synthra-graph/. No servers, no hooks.",
      opts: [{ flag: "--full", desc: "Re-parse every file, ignoring the incremental parse cache" }],
    },
    {
      cmd: "syn serve [path]",
      desc: "Start the HTTP MCP server only, against an already-scanned project.",
    },
    {
      cmd: "syn dashboard [path]",
      desc: "Run this dashboard as a standalone process (no graph required) — token spend, savings, the Moat, and your Arsenal across every registered project.",
    },
    {
      cmd: "syn doctor [path]",
      desc: "Diagnose the setup: Node version, jq (required by the macOS/Linux hooks), the claude CLI, graph freshness, .mcp.json registration, policy version, and installed hooks. Run this first when something feels off.",
      opts: [
        {
          flag: "--report",
          desc: "Emit a copy-pasteable markdown diagnostic for GitHub issues (paths redacted)",
        },
      ],
    },
    {
      cmd: "syn remove [path]",
      desc: "Uninstall Synthra from a project: deletes .synthra-graph/ and .synthra/, strips the CLAUDE.md policy block, Synthra's .gitignore entries, and its hooks — your own content in those files always survives. Also deregisters MCP and removes the project from this dashboard. Shows a summary and asks [y/N] first.",
      opts: [{ flag: "--yes", desc: "Skip the confirmation prompt (required when not in a terminal)" }],
    },
    {
      cmd: "syn --version",
      desc: "Print the installed Synthra version.",
    },
  ];
</script>

<div class="syn-commands flex h-full flex-col gap-4 p-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="font-serif text-2xl text-foreground">❯ Commands</h1>
    <span class="font-mono text-xs text-muted-foreground">all paths default to the current directory</span>
  </div>

  <div class="flex max-w-3xl flex-col gap-2.5">
    {#each commands as c (c.cmd)}
      <div class="flex flex-col gap-1.5 rounded-lg border bg-card/55 p-4">
        <code class="font-mono text-sm text-foreground">{c.cmd}</code>
        <p class="text-sm leading-snug text-muted-foreground">{c.desc}</p>
        {#if c.opts?.length}
          <div class="mt-1 flex flex-col gap-1">
            {#each c.opts as o (o.flag)}
              <div class="flex items-baseline gap-3 text-sm">
                <code class="shrink-0 font-mono text-xs text-[var(--c-sonnet)]">{o.flag}</code>
                <span class="text-muted-foreground">{o.desc}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <p class="max-w-3xl font-mono text-xs leading-relaxed text-muted-foreground">
    Install: <code class="text-foreground">npm install -g @jefuriiij/synthra</code> · macOS/Linux hooks
    additionally need <code class="text-foreground">jq</code> (<code>brew install jq</code>) — without it
    the hooks silently no-op while the MCP tools keep working.
  </p>
</div>
