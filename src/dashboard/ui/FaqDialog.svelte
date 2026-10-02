<script lang="ts">
  import { Dialog } from "bits-ui";
  let { open = $bindable(false) }: { open: boolean } = $props();

  const faqs: { q: string; a: string }[] = [
    {
      q: "Where do these numbers come from?",
      a: "After each Claude reply, Synthra reads Claude Code's own record of the chat and writes the token counts to .synthra-graph/token_log.jsonl in your project. The dashboard only reads those files. Nothing leaves your computer.",
    },
    {
      q: "Why does Spend look so high? I pay a monthly plan.",
      a: "Spend is the token count times Anthropic's public API prices. On a Claude plan you pay the plan price, not this. The number shows what the same work would cost on the API, so you can compare chats and projects.",
    },
    {
      q: "How is \"Saved by Synthra\" counted?",
      a: "When Claude uses its Grep or Glob tool to look for something Synthra already has in its map, Synthra stops the search and gives Claude the answer. Each stopped search counts as 500 tokens at $3 per million, a low estimate on purpose. The card appears only once a search was stopped: Claude often searches through the terminal instead, which Synthra watches but never stops.",
    },
    {
      q: "Why does a project show no replies?",
      a: "Synthra must run in that project while you chat. Open the folder in VS Code with the Synthra extension, or run syn . in a terminal there. Replies from before Synthra started are not counted.",
    },
    {
      q: "Where are my skills, memory and agents?",
      a: "In the Synthra extension for VS Code and other editors. Its sidebar and large panel show Learning, Memory, Capabilities, Agents and Settings.",
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
      <Dialog.Description class="text-xs text-muted-foreground">What the numbers on this page mean.</Dialog.Description>
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
