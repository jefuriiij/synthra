<script lang="ts">
  import { Dialog } from "bits-ui";
  let { open = $bindable(false) }: { open: boolean } = $props();

  const faqs: { q: string; a: string }[] = [
    {
      q: "Where do these numbers come from?",
      a: "From small files Synthra writes in each project's .synthra-graph folder: one line per reply, per search, per Synthra tool call and per reminder, plus the time each hook last ran. The page only reads them. Nothing leaves your computer.",
    },
    {
      q: "What does \"Is it working?\" check?",
      a: "Each part of Synthra that runs inside Claude Code (a hook) notes when it last ran. When one stops while the others go on, or a project still has hook scripts from an older Synthra, the page says so. Old hooks can stop working without any sign, as the 0.33 hooks did once Claude moved into a subfolder.",
    },
    {
      q: "What does Fix hooks do?",
      a: "It writes that project's hook scripts in .claude/hooks again and registers them in .claude/settings.local.json, the same step syn . runs. Your own hooks and permissions stay. The new hooks work from the next Claude session on.",
    },
    {
      q: "How is \"How Claude found code\" counted?",
      a: "Synthra map: Claude used one of Synthra's lookup tools, or Synthra answered a Grep or Glob search from its map. Whole files: the Read tool, or a terminal command like cat. Search: terminal searches like grep and rg, and Grep or Glob searches that ran. Missed chances are terminal commands that asked for code the map already knew.",
    },
    {
      q: "Why does Cost look so high? I pay a monthly plan.",
      a: "Cost is the token count times Anthropic's public API prices. On a Claude plan you pay the plan price, not this. The number shows what the same work would cost on the API, so you can compare weeks and projects.",
    },
    {
      q: "Where can I see and change my skills and memory?",
      a: "In the Synthra extension for VS Code and other editors. Its Learning, Memory and Settings tabs list every skill and note, and let you approve, pin, restore and change them.",
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
