# Synthra

> Local context engine for AI coding assistants. Graph-based context, branch-aware memory, real-time human-activity awareness, a deterministic Grep/Glob gate, and a live token dashboard.

Built first for Claude Code (IDE extension + CLI). Anything that speaks the Model Context Protocol can plug in.

```bash
npm install -g @jefuriiij/synthra
cd your-project
syn .
```

That's the whole install + run. Open the Claude Code IDE extension in the same folder and work normally; `Ctrl+C` the terminal when you're done.

---

## What it does

AI coding assistants burn tokens exploring the codebase on every turn — grep, glob, read, repeat. They also lose context between turns and across sessions, and they're blind to what *you* are doing in your editor between AI turns.

Synthra is a tiny local CLI that sits between you and your AI:

- **Pre-injects** a structured ~4K-token context pack (signatures + top function bodies + linked tests) into every session
- **Blocks** Grep/Glob calls deterministically at the PreToolUse hook layer when the graph already has the answer — the moat
- **Remembers** decisions and notes branch-by-branch in a git-tracked `.synthra/` directory so teammates inherit context
- **Watches** file saves, branch switches, and uncommitted diffs so the AI knows what just changed
- **Tracks** every token via Claude's transcript and reports estimated cost + savings on a live dashboard

When `syn .` runs, you see:

```
[syn]   ✅  scanned   123 files · 490 symbols · 574 edges
[syn]   🧠  MCP       http://127.0.0.1:8080   →  registered as 'synthra'
[syn]   📊  Dashboard http://127.0.0.1:8901
[syn]   🪝  Hooks     installed in .claude/settings.local.json

[syn]   🤖  Ready — open the Claude Code IDE extension (or run `claude` in another terminal).
```

---

## MCP tools

Synthra exposes ten tools to Claude over HTTP MCP. Claude calls these instead of Grep / Glob / Read for navigation:

| Tool | Purpose |
|---|---|
| `graph_continue(query)` | Return the structured context pack relevant to a query |
| `graph_read(target)` | Fetch source for a file or `file::symbol` |
| `graph_register_edit(files)` | Tell Synthra you edited files (boosts their ranking) |
| `context_remember(text, kind)` | Persist a decision / task / fact, branch-aware |
| `context_recall(kind?)` | Read previously-stored decisions |
| `recent_activity(since_ms?)` | What the human just saved / branch-switched / changed |
| `count_tokens(text)` | Char/4 estimate for prompt budgeting |
| `blast_radius(target, depth?)` | All files that depend on `target` transitively |
| `dead_code(limit?)` | Files no other file imports and no test references |

---

## Languages

Symbol extraction works for:

- **TypeScript / JavaScript** (`.ts`, `.tsx`, `.cts`, `.mts`, `.js`, `.jsx`, `.cjs`, `.mjs`)
- **Python** (`.py`, `.pyi`)
- **Svelte** (`.svelte`) — script blocks parsed as TS
- **Vue** (`.vue`) — same
- **Go** (`.go`)
- **Rust** (`.rs`)
- **Java** (`.java`)
- **Kotlin** (`.kt`, `.kts`)
- **PHP** (`.php`)
- **Ruby** (`.rb`)
- **C** (`.c`, `.h`)
- **C++** (`.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`)
- **C#** / .NET (`.cs`)
- **Dart** (`.dart`) — content indexed; symbol extraction is best-effort in v0.1

Files in other languages (HTML, CSS, JSON, YAML, Markdown, etc.) are walked and content-indexed so keyword search still finds them — just no symbol-level granularity.

---

## Commands

```bash
syn .                     # Default: scan + MCP + dashboard + hooks + claude mcp add.
                          # Terminal blocks on SIGINT; use the IDE extension.
syn . --launch-cli        # Also spawn the `claude` CLI in this terminal.
syn . --resume <id>       # Resume a Claude session (requires --launch-cli to take effect).
syn scan [path]           # Scan only — walk + parse + write graph.
syn serve [path]          # Start the MCP server only.
syn dashboard [path]      # Run only the token dashboard (standalone process).
```

---

## Storage layout

When `syn .` runs in a project:

```
your-project/
├── .gitignore                   # appended: .synthra-graph/
├── CLAUDE.md                    # appended: <!-- synthra-policy v1 ... -->
├── .claude/
│   ├── settings.local.json      # hooks merged (tagged with meta: "synthra-hook=true")
│   └── hooks/                   # synthra-prime.ps1, synthra-pre-tool-use.ps1, …
├── .synthra-graph/              # GITIGNORED — heavy machine-local state
│   ├── info_graph.json
│   ├── symbol_index.json
│   ├── activity.jsonl
│   ├── token_log.jsonl
│   ├── gate_log.jsonl
│   └── mcp_port
└── .synthra/                    # GIT-TRACKED — team's shared memory
    ├── context-store.json       # decisions, tasks, facts (default branch)
    ├── CONTEXT.md               # narrative summary
    └── branches/<sanitized>/    # per-branch overrides
```

A global registry at `~/.synthra/projects.json` lists every project where Synthra has run, so `syn dashboard` can show aggregate stats across all of them.

---

## Coexistence

Synthra is friendly with other AI-context tools. It only writes to its own `.synthra/` and `.synthra-graph/` paths, only modifies `CLAUDE.md` inside its own `<!-- synthra-policy v1 -->` markers, and tags hook entries with `meta: "synthra-hook=true"` so re-runs strip only its own entries from `settings.local.json`.

If another tool (e.g. GrapeRoot) also logs to the dashboard, Synthra dedupes overlapping entries on read.

---

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `SYN_MCP_PORT` | (auto 8080–8099) | Pin the MCP server port |
| `SYN_DASHBOARD_PORT` | `8901` | Dashboard preferred port (falls back through 8901–8910) |
| `SYN_HARD_MAX_READ_CHARS` | `4000` | Soft token budget for `graph_continue` packs |
| `SYN_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `SYN_CLAUDE_BIN` | `claude` | Override the `claude` binary location |
| `SYN_NO_UPDATE_CHECK` | `0` | Set to `1` to skip the daily version-check ping |

---

## How the moat works

The PreToolUse hook fires on every `Grep` / `Glob` call. The hook POSTs the tool input to Synthra's local server. The server runs the query through the graph and returns:

- `decision: "allow"` if the graph has no confident match (low confidence)
- `decision: "allow"` if the user just edited a matching file (recent-activity relaxation)
- `decision: "block"` otherwise, with a reason pointing Claude at `graph_continue`

Claude Code honors the block and tries again with the suggested MCP tool. The structured pack is cheaper, faster, and pre-ranked.

---

## Development

```bash
git clone https://github.com/jefuriiij/synthra
cd synthra
npm install
npm link              # makes `syn` available globally; rebuilds reflect immediately
npm run build         # tsup → dist/
npm run dev           # tsup --watch
npm test              # vitest
npm run typecheck     # tsc --noEmit
```

See [`ROADMAP.md`](./ROADMAP.md) for the milestone history (M1 scanner → M6 dashboard) and the v0.2 backlog.

---

## License

[MIT](./LICENSE)
