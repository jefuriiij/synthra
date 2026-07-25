# Synthra

> **Make Claude Code cheaper *and* sharper on your codebase.** Synthra is a tiny local engine that stops your AI assistant from re-exploring your project every turn, remembers what matters across sessions, and routes each task to the right-priced model — automatically.

**Install once. Fire and forget.**

```bash
npm install -g @jefuriiij/synthra
cd your-project
syn .
```

That's the whole setup. Open the Claude Code IDE extension in the same folder, work normally, and press `Ctrl+C` when you're done. Synthra runs quietly in the background — watching your file saves, blocking redundant searches, suggesting the cheapest model that can do the job, and tracking every token — until you have a reason to open the dashboard.

`@jefuriiij/synthra` · **MIT** · **Node ≥ 18** · **no SaaS, no telemetry, no account** · built first for Claude Code (IDE extension + CLI), but anything that speaks the Model Context Protocol can plug in.

---

## The problem

AI coding assistants are powerful but wasteful:

- They **re-explore your codebase on every turn** — grep → glob → read a whole file → repeat — burning tokens to rediscover things they already saw.
- They **lose context between turns and across sessions**, so you re-explain the same decisions.
- They're **blind to what *you* just did** in your editor between AI turns.
- They **default to your most expensive model for everything**, even trivial edits.

Synthra fixes all four — locally, with zero config.

---

## What Synthra does

### 💸 Spend less

- **Reads slices, not whole files.** Synthra parses your project into a symbol graph, so Claude fetches a single function (`graph_read("file.ts::Symbol")`, ~50 tokens) instead of a 2,000-token whole file.
- **The Moat blocks redundant searches.** A hook intercepts every Grep/Glob; if the graph already has the answer, the search is denied and Claude is handed the answer instead. It literally cannot burn tokens re-searching.
- **The Dispatcher suggests the right-priced model** — on demand. Ask `route_task("…")` and it names the best-fit agent from your installed toolkit plus a model to run it on: plan on your premium model, execute on a cheaper one (**Sonnet is ≈ 5× cheaper than Opus**). It no longer volunteers hints unprompted — see [How the Dispatcher works](#how-the-dispatcher-works).

### 🧠 Get smarter answers

- **Pre-loaded context.** At session start Claude gets a ~4K-token pack of the signatures, top function bodies, and linked tests most relevant to your project.
- **A second brain that talks back.** Decisions and notes you save resurface *automatically* when you touch the relevant file — and get flagged if the code changed since you saved them.
- **Difficulty-aware routing.** Hard tasks (races, leaks, migrations, security…) are kept on your primary model instead of being cheaped-out.
- **Knows what you just edited.** A file + git watcher means Claude isn't answering from a stale snapshot.

---

## What it saves you (real measurement)

Same prompt, same Opus model, same codebase across all runs — a controlled before/after on one real production project (a 3-turn WebSocket-auth walkthrough across 4 files). Synthra is language-agnostic; this just happened to be the test bed:

| Setup | Cost per session |
|---|---|
| Vanilla Claude Code | **$7.97** |
| Synthra w/ MCP fixes (v0.1.6) | **$4.26** (-46%) |
| Synthra w/ full graph tools (v0.1.7+) | **$2.05** (-74%) |

**Up to −74% on a code-heavy session.** Savings vary with workload — a markup/CMS-heavy session leans on the graph less than a refactor does. The dashboard shows the **Savings (floor)** math live (`blocks × 500 tokens × $3/M`), so you verify the number for your own sessions instead of trusting it on faith.

The newer, bigger lever is **model routing**: on heavy usage the assistant can default the large majority of turns to Opus — routing execution to Sonnet cuts those turns ~5×. The Dispatcher makes that the default habit instead of a thing you remember to do.

---

## Features at a glance

| Feature | What it does | Why you care |
|---|---|---|
| **Graph context pack** | Pre-injects signatures + top bodies + linked tests at session start | Claude starts oriented, without reading whole files |
| **The Moat** | PreToolUse hook deterministically blocks Grep/Glob the graph can already answer | Kills redundant, expensive searching |
| **The Dispatcher** | `route_task` scores a task against your installed agents/skills + project language and names the best fit + model. Runs in shadow mode passively (records, doesn't interrupt) | Right tool, right-priced model — when you ask |
| **Difficulty escalation** | Flags complex tasks (races, leaks, security…) to stay on your primary model | Cheap where safe, powerful where it matters |
| **Branch-aware memory** | `context_remember` / `context_recall` persist decisions per git branch in `.synthra/` (git-tracked) | Teammates inherit context; it merges naturally |
| **Auto-resurfacing** | Saved notes reappear on the files they relate to, with a stale-since-saved warning | A memory that actually speaks up |
| **Activity awareness** | Watches file saves, branch switches, uncommitted diffs | Claude knows what you changed between turns |
| **Live token dashboard** | Cost, model breakdown, savings floor, Moat blocks, hot files | See exactly where your spend goes |
| **Reuse detection** | `find_symbol` / `duplicate_symbols` surface existing code before you write new | Less duplicated, over-engineered code |
| **Edit-safety** | `blast_radius` shows callers + guarding tests before a rename | Change things without breaking them |
| **Auto-reindex on edit** | The graph rescans ~1s after edits settle | Tools never serve stale code mid-session |
| **Team reporting** | `syn doctor --report` + dashboard Report button emit a redacted diagnostic | Colleagues report issues you can actually debug |
| **Self-update with consent** | Checks npm on run, prompts `[y/N]`, prints the changelog | Stay current without surprise upgrades |

---

## Quick start

```bash
npm install -g @jefuriiij/synthra   # 1. install globally
cd your-project                     # 2. any project root
syn .                               # 3. scan + serve + dashboard + hooks
```

After `syn .` finishes you'll see:

```
  ✅  scanned   123 files · 490 symbols · 574 edges
  🧠  MCP       http://127.0.0.1:8080   →  registered as 'synthra'
  📊  Dashboard http://127.0.0.1:8901
  🪝  Hooks     installed in .claude/settings.local.json

  🤖  Ready — open the Claude Code IDE extension (or run `claude` in another terminal).
      Synthra's tools and gate will be active for that session.

  Press Ctrl+C here when you're done.
```

**Then just work.** Open the Claude Code IDE extension (or run `claude`) in the same folder. Synthra's context pack, the Moat, and the Dispatcher are active for that session automatically — you don't call anything by hand. Open **http://127.0.0.1:8901** any time to watch cost and savings live. When you're finished, `Ctrl+C` the `syn .` terminal.

Changed your mind, or ran `syn .` in the wrong folder? `syn remove` cleanly reverses everything (see [Commands](#commands)).

---

## Prerequisites

| Need | Why |
|---|---|
| **Node ≥ 18** | Synthra is pure Node ESM |
| **The `claude` CLI on PATH** | Used to register Synthra's MCP server so the IDE/CLI sees its tools |
| **A project folder** | `syn .` scans the current directory |
| **`jq` (macOS/Linux only)** | The bash hooks pipe JSON through `jq`; without it they silently no-op. `brew install jq` / `apt install jq`. Not needed on Windows (PowerShell hooks). |

No account, no extra API key beyond what Claude Code already uses, and no external network service. Everything runs on localhost.

Not sure your setup is healthy? Run **`syn doctor`** — a read-only checklist (Node, jq, claude CLI, graph freshness, `.mcp.json`, policy version, hooks).

---

## Supported languages

**Full symbol extraction** (tree-sitter — functions, classes, methods, types, imports, call edges):

- **TypeScript / JavaScript** — `.ts` `.tsx` `.cts` `.mts` `.js` `.jsx` `.cjs` `.mjs`
- **Python** — `.py` `.pyi`
- **Svelte** `.svelte` · **Vue** `.vue` (`<script>` blocks reparsed as TS)
- **Go** `.go` · **Rust** `.rs` · **Java** `.java` · **Kotlin** `.kt` `.kts`
- **PHP** `.php` · **Ruby** `.rb`
- **C** `.c` `.h` · **C++** `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx`
- **C# / .NET** `.cs`
- **Dart** `.dart` — class/mixin/extension/enum/typedef/function/method/getter/setter + import normalization

**HubL / HTML** (`.html`, `.hubl`) — regex-based: `{% macro %}` → function, `{% block %}` → component, `{% include/extends/import %}` → import edges. (No tree-sitter grammar exists for HubL.)

**Everything else** (CSS, JSON, YAML, Markdown, …) is walked and content-indexed, so keyword search still finds it — just without symbol-level granularity.

---

## Supported machines

| Platform | Status |
|---|---|
| **Windows** | ✅ **Tested.** PowerShell hook scripts; primary development target. |
| **macOS / Linux** | ⚠️ **Best-effort.** Bash hook scripts ship and the installer picks them automatically. Needs `jq` on PATH (see prerequisites). The full `syn .` flow is wired but not yet exhaustively verified on POSIX — including Claude Code in IntelliJ on macOS. |

The platform-agnostic parts — `syn scan`, `syn serve`, `syn dashboard`, the MCP server, and the dashboard — are pure Node and run anywhere Node 18+ does. The hook integration is what's Windows-verified. Running on macOS/Linux? [Open an issue](https://github.com/jefuriiij/synthra/issues) with what you find — or use the dashboard's **Report** button (below).

---

## The dashboard

Live at **http://127.0.0.1:8901** (falls back through 8901–8910 if the port is busy). Three views plus two dialogs:

- **Overview** — cost hero, model breakdown donut, the Moat card, savings floor, hot files, recent turns, tool usage.
- **Arsenal** — every skill, subagent, and MCP server installed for this project (scoped project / personal / plugin) with descriptions — so you never drop to the CLI to recall your toolkit.
- **Commands** — every `syn` command with its flags and description.
- **Report** — runs the doctor checks live and shows the ✅/⚠️/❌ list (often that alone is the fix). One click copies a **redacted** markdown diagnostic (home paths → `~`); two buttons open GitHub's bug / feature forms. Nothing is ever sent automatically.
- **FAQ** — the short version of this README.

---

## MCP tools

Thirteen tools exposed over HTTP MCP (namespaced `mcp__synthra__*`). Claude calls these instead of Grep / Glob / Read for navigation:

| Tool | Purpose |
|---|---|
| `graph_continue(query)` | The structured context pack — confidence label + files + signatures + top bodies. Call *before* Grep/Glob. |
| `graph_read(target)` | Fetch source for `file.ts` or `file.ts::Symbol` (~50 tokens vs thousands). A symbol read also returns its dependency surface — callee signatures + caller names. |
| `graph_register_edit(files)` | Tell Synthra you edited files — boosts ranking, avoids stale snapshots. |
| `context_remember(text, kind)` | Persist a decision / task / next-step / fact / blocker, branch-aware, into git-tracked `.synthra/`. |
| `context_recall(kind?)` | Read previously-stored entries (defaults to the current branch). |
| `recent_activity(since_ms?)` | What the human just saved / branch-switched / changed. |
| `count_tokens(text)` | Char/4 estimate for prompt budgeting. |
| `blast_radius(target, depth?)` | What could break before an edit — dependent files, or the exact caller symbols + guarding tests for a `file::symbol` target. |
| `dead_code(limit?)` | Files no other file imports and no test references (entry points excluded). |
| `find_symbol(name)` | Find existing symbols by name *before* writing a new one — reuse beats re-implementing. |
| `duplicate_symbols(limit?)` | Names defined in more than one file — consolidation candidates (advisory). |
| `call_path(from, to, depth?)` | The shortest chain of calls from one symbol to another — trace control flow. |
| `route_task(task)` | Which installed agent/skill fits a task, and which model to run it on — the Dispatcher, on demand. |

---

## Commands

```bash
syn .                     # Default: scan + MCP + dashboard + hooks + register MCP.
                          # Background service; Ctrl+C to stop.
syn . --launch-cli        # Also spawn the `claude` CLI in this terminal.
syn . --resume <id>       # Resume a Claude session (requires --launch-cli).
syn . --full              # Re-parse every file, ignoring the incremental cache.
syn scan [path]           # Scan only — walk + parse + write graph. (--full available)
syn serve [path]          # Start the HTTP MCP server only.
syn dashboard [path]      # Run only the token dashboard (localhost:8901).
syn doctor [path]         # Diagnose this project's Synthra setup + environment.
syn doctor --report       # Copy-pasteable markdown diagnostic for GitHub issues
                          # (also available via the dashboard's Report button).
syn remove [path]         # Uninstall Synthra from a project — reverses the whole
                          # bootstrap. Asks [y/N]; --yes to skip. Your own gitignore
                          # lines / CLAUDE.md content / hooks always survive.
```

---

## How the Moat works

The PreToolUse hook fires on every `Grep` / `Glob` (and observes `Bash` exploration commands). It POSTs the tool input to Synthra's local server, which runs the query through the graph and returns:

- `allow` if the graph has no confident match (low confidence),
- `allow` if you just edited a matching file (recent-activity relaxation),
- `block` otherwise — **and the deny message carries the answer**: copy-pasteable `graph_read("file::symbol")` targets + one-line signatures.

Claude Code honors the block and pivots to the MCP tool. The structured pack is cheaper, faster, and pre-ranked. Claude literally cannot disobey. (Bash searches like `rg foo src/` are never blocked — they're only *logged*, so the dashboard can show how often the terminal is used to route around the graph.)

## How the Dispatcher works

The UserPromptSubmit hook sends each prompt to `/route`, which scores it against **every installed agent and skill** (plus your project's language fingerprint and a difficulty estimate) and picks a best-fit agent, model, and skill.

**Since v0.21 it runs in shadow mode by default: it records its verdict and injects nothing.** Synthra's own instrumentation is the reason — across 390 real prompts, injected hints were followed **2 times (1.2%)**, and two-thirds of them had fired on IDE notices rather than anything a human typed. Rather than keep spending your context on that, the Dispatcher stays quiet and logs what it *would* have said; the dashboard reports it as "would have hinted N". It gets to speak again when the numbers say it earned it.

- **`route_task(task)`** always answers on demand — the verbose, ranked report with the model recommendation. This is the intended way to use it today.
- Complex tasks (races, leaks, migrations, security…) are flagged to **stay on your primary model** rather than being cheaped-out.
- `SYN_ROUTE_HINTS=1` re-enables passive injection; `SYN_ROUTE_MIN_SCORE` (default 5) tunes how eager it is; `SYN_NO_ROUTE=1` turns the whole thing off, scoring and logging included.

---

## Storage layout

When `syn .` runs in a project:

```
your-project/
├── .gitignore                   # appended: .synthra-graph/, .mcp.json (with comments)
├── .mcp.json                    # Synthra registers here at --scope project so the IDE sees it.
│                                # Gitignored by default — remove the line to share with teammates.
├── CLAUDE.md                    # appended: <!-- synthra-policy v9 BEGIN/END --> markers
├── .claude/
│   ├── settings.local.json      # 5 hooks merged (tagged meta: "synthra-hook=true")
│   └── hooks/                   # synthra-prime, -pre-tool-use, -pre-compact, -stop, -route (.ps1/.sh)
├── .synthra-graph/              # GITIGNORED — heavy machine-local state
│   ├── info_graph.json
│   ├── symbol_index.json
│   ├── activity.jsonl · token_log.jsonl · gate_log.jsonl · route_log.jsonl
│   └── mcp_port
└── .synthra/                    # GIT-TRACKED — the team's shared memory
    ├── context-store.json       # decisions, tasks, facts (default branch)
    ├── CONTEXT.md               # narrative summary (Stop hook re-renders this)
    └── branches/<sanitized>/    # per-branch overrides
```

Five hooks are installed: **SessionStart** (inject the context pack), **PreToolUse** (the Moat + Bash observer), **PreCompact**, **Stop** (log tokens + refresh CONTEXT.md), and **UserPromptSubmit** (the Dispatcher). A global registry at `~/.synthra/projects.json` lists every project where Synthra has run, so `syn dashboard` can show aggregate stats.

---

## Coexistence

Synthra plays nicely alongside other AI-context tools. It only writes to its own `.synthra/`, `.synthra-graph/`, and a single `synthra` entry inside `.mcp.json` (existing entries preserved). It only modifies `CLAUDE.md` inside `<!-- synthra-policy v9 -->` markers, and tags hook entries with `meta: "synthra-hook=true"` so re-runs strip only its own. Your content in shared files **always** survives — `syn remove` proves it, leaving your gitignore lines, CLAUDE.md prose, and other hooks intact. If another tool logs to a shared `token_log.jsonl`, the dashboard dedupes overlapping entries so totals don't double-count.

---

## Configuration

Everything works with zero config. Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `SYN_MCP_PORT` | (auto 8080–8099) | Pin the MCP server port |
| `SYN_DASHBOARD_PORT` | `8901` | Dashboard preferred port (falls back 8901–8910) |
| `SYN_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `SYN_CLAUDE_BIN` | `claude` | Override the `claude` binary location |
| `SYN_ROUTE_HINTS` | _(unset)_ | Set to `1` to let the Dispatcher inject per-prompt hints again (off by default since v0.21 — see [How the Dispatcher works](#how-the-dispatcher-works)) |
| `SYN_ROUTE_MIN_SCORE` | `5` | Minimum match score before a routing verdict counts (higher = quieter) |
| `SYN_NO_ROUTE` | _(unset)_ | Disable the Dispatcher entirely, including its shadow logging (`route_task` still works) |
| `SYN_NO_AUTOREINDEX` | _(unset)_ | Disable auto-reindex-on-edit |
| `SYN_NO_BASH_OBSERVE` | _(unset)_ | Disable the observe-only Bash exploration logger |
| `SYN_NO_UPDATE_CHECK` | `0` | Set to `1` to skip the daily version-check ping |
| `SYN_DASHBOARD_DEDUPE` | `1` | Set to `0`/`off`/`false` to see every raw token-log entry |

Advanced tuning knobs (read budgets, cache TTLs, gate-hint size, usage-learning decay) also exist as `SYN_*` vars — see `src/shared/config.ts` if you need to fine-tune retrieval.

---

## Self-update

Every `syn .` checks the npm registry for a newer version (no cache — always fresh; 2s hard timeout; silent on network failure). On latest, the check is silent and `syn .` proceeds. When you're behind:

- **Interactive shell (TTY)** → `[syn] Synthra X.Y.Z is available (you have A.B.C). Update now? [y/N]:` *before* the scan. `y` installs; Enter skips and continues.
- **Non-interactive (CI, piped stdin)** → a silent one-line hint, no prompt.
- **Disabled** → `SYN_NO_UPDATE_CHECK=1`.

On `y`, Synthra runs `npm install -g @jefuriiij/synthra@latest` (you see npm's progress), **prints the new version's `CHANGELOG.md` section**, then exits with re-run instructions — the running Node process is still the old version and can't hot-swap itself mid-run. If you upgrade directly outside the prompt, the next `syn .` notices and prints the changelog anyway (tracked in `~/.synthra/last-seen-version.json`).

---

## Report a bug / request a feature

Open the dashboard's **Report** button or run **`syn doctor --report`**, copy the redacted diagnostic, and paste it into a [GitHub issue](https://github.com/jefuriiij/synthra/issues). The bug template asks for that diagnostic so every report arrives debuggable — no telemetry, just copy-and-paste on your terms.

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

See [`ROADMAP.md`](./ROADMAP.md) for milestone history and backlog.

---

## License

[MIT](./LICENSE) — fork freely, ship freely, just keep the attribution. If Synthra ends up useful inside your own tool or product, a link back is appreciated but not required.
