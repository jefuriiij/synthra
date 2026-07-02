# Synthra

> Local context engine for AI coding assistants. **Install once. Fire and forget.** Claude Code stops burning tokens on grep → glob → read → repeat — it queries a structured graph instead.

Built first for Claude Code (IDE extension + CLI). Anything that speaks the Model Context Protocol can plug in.

```bash
npm install -g @jefuriiij/synthra
cd your-project
syn .
```

That's the whole setup. Open the Claude Code IDE extension in the same folder and work normally; `Ctrl+C` the terminal when you're done. Synthra hangs out in the background, watching for file saves, blocking redundant Greps, and tracking every turn — until you have a reason to look at the dashboard.

---

## What it saves you (real measurement)

Same prompt, same Opus model, same Svelte/Node codebase. Dogfooding on a real production project (`windsor-stables`) shows:

| Setup | Cost per session |
|---|---|
| Vanilla Claude Code | **$7.97** |
| Synthra w/ MCP fixes (v0.1.6) | **$4.26** (-46%) |
| Synthra w/ full graph tools (v0.1.7+) | **$2.05** (-74%) |

A 3-turn WebSocket-auth walkthrough across 4 files. The savings come from Claude reading function signatures (`graph_read("file.ts::Symbol")`, ~50 tokens) instead of whole files (~2,000+), and from skipping Greps that the Moat blocks because the graph already has the answer.

The math behind the dashboard's **Savings (floor)** card is shown live (`blocks × 500 tokens × $3/M`) so you can verify it for your own sessions instead of trusting the number on faith.

---

## What it does

AI coding assistants burn tokens exploring the codebase on every turn. They lose context between turns and across sessions. They're blind to what *you* are doing in your editor between AI turns.

Synthra is a tiny local CLI (~273 KB tarball, no SaaS, no telemetry, MIT) that sits between you and your AI:

- **Pre-injects** a structured ~4K-token context pack (signatures + top function bodies + linked tests) at session start
- **The Moat** — deterministically blocks Grep/Glob at the PreToolUse hook layer when the graph already has the answer. Returns `{"decision":"block"}` — Claude literally cannot disobey.
- **Remembers** decisions and notes branch-by-branch in a git-tracked `.synthra/` directory so teammates inherit context
- **Watches** file saves, branch switches, and uncommitted diffs (chokidar + a `.git/HEAD` watcher) so the AI knows what just changed
- **Tracks** every token via Claude's transcript and reports estimated cost + savings on a live dashboard
- **Updates with consent** — daily npm check prompts you on a TTY (`Update now? [y/N]`) and stays silent on CI

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

Ten tools exposed over HTTP MCP (namespaced as `mcp__synthra__*`). Claude calls these instead of Grep / Glob / Read for navigation:

| Tool | Purpose |
|---|---|
| `graph_continue(query)` | Return the structured context pack — `Confidence` label + `Files` list + signatures + top function bodies |
| `graph_read(target)` | Fetch source for `file/path.ts` or `file/path.ts::SymbolName` (the latter returns ~50 tokens vs thousands for a whole file) |
| `graph_register_edit(files)` | Tell Synthra you edited files (boosts their ranking, avoids stale snapshots) |
| `context_remember(text, kind)` | Persist a decision / task / fact / next-step / blocker, branch-aware |
| `context_recall(kind?)` | Read previously-stored entries |
| `recent_activity(since_ms?)` | What the human just saved / branch-switched / changed |
| `count_tokens(text)` | Char/4 estimate for prompt budgeting |
| `blast_radius(target, depth?)` | All files that depend on `target` transitively |
| `dead_code(limit?)` | Files no other file imports and no test references |

---

## Languages

Full symbol extraction:

- **TypeScript** (`.ts`, `.tsx`, `.cts`, `.mts`, `.jsx`) — interfaces, type aliases, enums, classes, methods, arrow consts, ES imports
- **JavaScript** (`.js`, `.cjs`, `.mjs`) — uses a JS-specific tree-sitter query (v0.1.7+) that captures CommonJS `require()` calls in addition to ES `import` statements, and uses the JS grammar's `(identifier)` node for class names
- **Python** (`.py`, `.pyi`)
- **Svelte** (`.svelte`) — `<script>` blocks reparsed as TS
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

Files in other formats (HTML, CSS, JSON, YAML, Markdown, images, etc.) are walked and content-indexed so keyword search still finds them — just no symbol-level granularity.

---

## Commands

```bash
syn .                     # Default: scan + MCP + dashboard + hooks + claude mcp add.
                          # Background-service; Ctrl+C to stop.
syn . --launch-cli        # Also spawn the `claude` CLI in this terminal.
syn . --resume <id>       # Resume a Claude session (requires --launch-cli).
syn scan [path]           # Scan only — walk + parse + write graph.
syn serve [path]          # Start the MCP server only.
syn dashboard [path]      # Run only the token dashboard (standalone process).
syn doctor [path]         # Diagnose this project's Synthra setup + environment.
syn remove [path]         # Uninstall Synthra from a project (accidental `syn .`?
                          # This reverses it). Asks [y/N]; --yes to skip. Your own
                          # gitignore lines / CLAUDE.md content / hooks survive.
```

---

## Storage layout

When `syn .` runs in a project:

```
your-project/
├── .gitignore                   # appended: .synthra-graph/, .mcp.json (with comments)
├── .mcp.json                    # Synthra registers here at --scope project so the IDE sees it.
│                                # Gitignored by default — remove the .gitignore line to share with teammates.
├── CLAUDE.md                    # appended: <!-- synthra-policy v2 ... -->
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

Synthra plays nicely alongside other AI-context tools. It only writes to its own `.synthra/`, `.synthra-graph/`, and a single `synthra` entry inside `.mcp.json` (existing entries are preserved). It only modifies `CLAUDE.md` inside `<!-- synthra-policy v2 -->` markers. It tags hook entries with `meta: "synthra-hook=true"` so re-runs strip only its own entries from `settings.local.json`. If another tool also logs to a shared `token_log.jsonl`, the dashboard dedupes overlapping entries on read so totals don't double-count.

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
| `SYN_NO_UPDATE_CHECK` | `0` | Set to `1` to disable the daily version-check ping |

---

## How the moat works

The PreToolUse hook fires on every `Grep` / `Glob` call. The hook POSTs the tool input to Synthra's local server. The server runs the query through the graph and returns:

- `decision: "allow"` if the graph has no confident match (low confidence)
- `decision: "allow"` if the user just edited a matching file (recent-activity relaxation)
- `decision: "block"` otherwise, with a reason pointing Claude at `graph_continue`

Claude Code honors the block and pivots to the MCP tool. The structured pack is cheaper, faster, and pre-ranked. The CLAUDE.md policy block (managed by Synthra inside its own `<!-- synthra-policy v2 -->` markers) tells Claude when to call `graph_continue` and — importantly — when to skip it, so follow-up turns don't pay the pack cost again.

---

## Self-update

Every `syn .` checks the npm registry for a newer version (no cache — always fresh; 2s hard timeout; silent fallthrough on network failure). When you're on latest, the check stays silent and `syn .` proceeds. When you're outdated:

- **Interactive shell** (TTY) → you see `[syn] Synthra X.Y.Z is available (you have A.B.C). Update now? [y/N]:` *before* the scan starts. Type `y` to install; press Enter (or anything else) to skip and continue with the current version.
- **Non-interactive** (CI, piped stdin) → silent one-line hint, no prompt.
- **Disabled entirely** → set `SYN_NO_UPDATE_CHECK=1`.

On `y`, Synthra spawns `npm install -g @jefuriiij/synthra@latest` with stdio inherited (you see npm's progress), then **prints the new version's `CHANGELOG.md` section** (so you know what you just got), then exits with re-run instructions — the running Node process is still the old version and can't hot-swap its own code mid-run.

If you upgrade via `npm install -g @jefuriiij/synthra@latest` directly (outside Synthra's prompt), the next `syn .` notices and prints the changelog anyway. It tracks the last-seen version at `~/.synthra/last-seen-version.json`.

---

## Platform support

| Platform | Status |
|---|---|
| **Windows** | ✅ Tested. PowerShell hook scripts; primary development target. |
| **macOS / Linux** | ⚠️ Best-effort. Bash hook scripts ship and the installer selects them automatically, but the full `syn .` flow hasn't been verified on POSIX yet. The Stop hook (token logging) needs `jq` on PATH or it silently no-ops. |

The platform-agnostic parts — `syn scan`, `syn serve`, `syn dashboard`, the MCP server, and the dashboard — are pure Node and run anywhere Node 18+ does. The hook integration is what's Windows-verified; POSIX is wired but untested. If you run it on macOS/Linux, [open an issue](https://github.com/jefuriiij/synthra/issues) with what you find.

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

See [`ROADMAP.md`](./ROADMAP.md) for milestone history (M1 scanner → M6 dashboard) and the v0.2 backlog.

---

## License

[MIT](./LICENSE) — fork freely, ship freely, just keep the attribution. If Synthra ends up useful inside your own tool or product, a link back is appreciated but not required.
