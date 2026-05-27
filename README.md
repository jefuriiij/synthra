# Synthra

> Local context engine for AI coding assistants. Graph-based context, branch-aware memory, real-time human-activity awareness.

**Status:** v0.0.1 — under active development. Not yet usable.

---

## What it does

AI coding assistants (Claude Code, Codex, Cursor) burn tokens exploring codebases on every turn — grep, glob, read, repeat. They also lose context between turns and sessions, and they are blind to what you are doing in your editor between AI turns.

Synthra is a local CLI that sits between you and your AI:

```
syn .         # scan project, start MCP server, launch Claude with pre-loaded context
```

It builds a semantic graph of your codebase, packs the relevant files into each prompt *before* the AI sees your question, and tracks what you and the AI are doing across turns and sessions.

---

## Features

- **Pre-injection of structured context.** Graph-derived signatures + top function bodies are packed into Claude's prompt *before* it sees your question. No exploration tax, no Grep loop.
- **Branch-aware, git-tracked cross-session memory.** Decisions, tasks, and notes live in `.synthra/` (committed to the repo, partitioned by branch). Switch machines or onboard a teammate and the context follows.
- **Deterministic enforcement via PreToolUse hook.** When the graph already has the answer, Grep/Glob calls are blocked at the hook layer. No "please use the graph" prose policy that the model can ignore.
- **Real-time human-activity awareness.** chokidar file watcher + `.git/HEAD` + `git status` poller feeds Claude a "you just saved `auth.ts` 12s ago, here's the diff" signal automatically.
- **Per-turn cost breakdown with savings delta.** Dashboard shows where every token goes (system / conversation / pack / message / response) and estimates what the conversation would have cost without Synthra.
- **Test ↔ source co-retrieval.** When packing context for `getUser.ts`, the matching `getUser.test.ts` comes along for free.
- **Fully MIT open-source.** Engine and launcher.

---

## Architecture

```
syn .
  │
  ├─ Scanner          tree-sitter → info_graph.json + symbol_index.json
  ├─ MCP server       HTTP, ports 8080–8099
  ├─ Activity watcher chokidar + git
  ├─ Context packer   ~4K-token structured pack per turn
  └─ Hooks            SessionStart, PreToolUse (the moat), PreCompact, Stop
```

See [ROADMAP.md](./ROADMAP.md) for the full implementation plan and milestones.

---

## Install

Not yet published. When ready:

```bash
npm install -g synthra
```

---

## Quick start (future)

```bash
cd your-project
syn .
```

Synthra will:
- Scan the project into a local graph (gitignored)
- Patch `CLAUDE.md` with a versioned policy block
- Start an MCP server on a free port
- Register four hooks with Claude Code
- Launch `claude` with pre-loaded context

On Ctrl+C:

```
[syn] To resume this session: syn --resume <session-id>
```

---

## Develop

```bash
npm install
npm run build       # tsup → dist/
npm run dev         # tsup --watch
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

---

## License

[MIT](./LICENSE)
