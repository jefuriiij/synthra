<script lang="ts">
  import { Dialog } from "bits-ui";
  let { open = $bindable(false) }: { open: boolean } = $props();

  const faqs: { q: string; a: string }[] = [
    {
      q: "Where do these numbers come from?",
      a: "Synthra's Stop hook reads Claude Code's transcript JSONL after each turn and logs token usage to .synthra-graph/token_log.jsonl. The gate logs to gate_log.jsonl, tool calls to tool_log.jsonl. The dashboard reads those — it never feeds back into retrieval.",
    },
    {
      q: "How is cost calculated?",
      a: "Token counts × Anthropic's published per-model rates (in src/shared/pricing.ts), summed across input, output, cache-read and cache-write. These are API-equivalent estimates, not your plan billing — useful for comparing sessions.",
    },
    {
      q: "What is the savings floor?",
      a: "Each time the Moat blocks an exploratory Grep/Glob, we credit a deliberately conservative 500 tokens × $3/M input rate. Real savings are usually higher (it ignores cache thrash and follow-up reads the block also prevents). It's a floor, not a guess.",
    },
    {
      q: "What is the Moat?",
      a: "A PreToolUse hook that intercepts Grep/Glob and, when the graph has confident context, blocks them and hands back the exact graph_read targets + signatures — so the agent reads ~50-token slices instead of whole files.",
    },
    {
      q: "What is the Dispatcher?",
      a: "A UserPromptSubmit hook that scores each prompt against every installed agent and skill (plus the project's language fingerprint) and injects a one-line hint: best-fit agent, recommended model, relevant skill. Complex tasks (races, leaks, migrations…) are flagged to stay on your primary model; the rest delegate to cheaper models. The card shows every decision from route_log.jsonl.",
    },
    {
      q: "What is the Arsenal view?",
      a: "A scan of every skill, subagent, and MCP server available to you — project, personal (~/.claude), and plugin — with descriptions, so you never have to drop to the CLI to recall what's installed. MCP entries show name/type/url only; auth tokens are never read.",
    },
    {
      q: "What's the codebase graph?",
      a: "tree-sitter parses your project into a symbol graph (files, symbols, imports, call edges). graph_read returns a symbol's source plus its dependency surface; graph_continue packs a context bundle.",
    },
    {
      q: "Where is everything stored?",
      a: ".synthra-graph/ (machine-local, gitignored) holds the graph + logs; .synthra/ (git-tracked) holds branch-aware memory. Nothing leaves your machine.",
    },
    {
      q: "Why is my bill not lower already?",
      a: "Savings land only when the agent actually uses the cheap path. v0.4–0.6 push the answer to the point of use (block payloads, edit recipes, dependency footers); a real dogfood session on the latest version is the true test.",
    },
  ];
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/60" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-card p-6 text-card-foreground shadow-2xl"
    >
      <Dialog.Title class="font-serif text-2xl">FAQ</Dialog.Title>
      <Dialog.Description class="text-xs text-muted-foreground">Where every number on this dashboard comes from.</Dialog.Description>
      <div class="mt-4 flex flex-col gap-2">
        {#each faqs as f (f.q)}
          <details class="rounded-lg border bg-card/50 p-3">
            <summary class="cursor-pointer text-sm font-medium text-foreground">{f.q}</summary>
            <p class="mt-2 text-[13px] leading-relaxed text-muted-foreground">{f.a}</p>
          </details>
        {/each}
      </div>
      <Dialog.Close class="mt-4 w-full rounded-md border py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        Close
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
