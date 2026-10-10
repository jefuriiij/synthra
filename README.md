# Synthra

> **A memory and a skill book for Claude Code.** Synthra is a small local engine that maps your code so Claude reads one function instead of a whole file, remembers what matters about each project and about you, and learns the workflows Claude figures out, with your OK. Claude stays the brain.

`@jefuriiij/synthra` · **MIT** · **Node 18+** · **no SaaS, no telemetry, no account** · built first for Claude Code, and any tool that reads `AGENTS.md` (Codex, Cursor, Copilot, Gemini CLI and others) gets the project's knowledge too.

---

## Get started

### The easy way: the editor extension

1. Install **Synthra** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jefuriiij.synthra-vscode), or from [Open VSX](https://open-vsx.org/extension/jefuriiij/synthra-vscode) for Cursor, Windsurf, VSCodium and Google Antigravity.
2. Open a project folder.
3. Click the **Synthra icon** in the activity bar. If the engine is missing, click **Install Synthra**. You need [Node.js 18 or later](https://nodejs.org/en/download).
4. Work with Claude as usual.

The extension starts Synthra when you open the folder and stops it when you close the window. Its sidebar and large panel show what Synthra knows: **Learning**, **Memory**, **Capabilities**, **Agents** and **Settings**.

### The terminal way

```bash
npm install -g @jefuriiij/synthra
cd your-project
syn .
```

Then open Claude Code (the IDE extension, or `claude`) in the same folder. Press `Ctrl+C` in the `syn .` terminal when you are done.

After `syn .` you see:

```
  ✅  scanned   123 files · 490 symbols · 574 edges
  🧠  MCP       http://127.0.0.1:8080   →  registered as 'synthra'
  📊  Dashboard http://127.0.0.1:8901
  🪝  Hooks     installed in .claude/settings.local.json

  🤖  Ready. Open the Claude Code IDE extension (or run `claude` in another terminal).
```

Ran it in the wrong folder? `syn remove` takes everything out again (see [Commands](#commands)).

---

## What Synthra does

### Claude reads less

- **Slices, not whole files.** Synthra parses your project into a symbol graph. Claude fetches one function with `graph_read("file.ts::Symbol")` (about 50 tokens) instead of a 2,000-token file.
- **A head start.** At the start of each session Claude gets a small pack (about 4K tokens) of the signatures, top function bodies and linked tests that matter most in your project.
- **Knows what you just changed.** A file and git watcher tells Claude what you saved or switched between replies, so it does not answer from a stale picture.

### Claude remembers

- **Project memory:** `.synthra/MEMORY.md`, a short list of what every AI should know about this project (how to build and test it, traps, where things live). It lives in git, so your team shares it.
- **About you:** `~/.synthra/USER.md`, how you like to work. Private to your computer, used in every project.
- Both load at the start of every session, and both have a size limit (3,500 and 2,000 characters), so they stay short and current. Claude edits them with the `memory` tool and gets a reminder every 10 replies.
- **Session notes** per git branch: the current task, next steps, decisions and facts. A note comes back by itself when you touch its file, with a warning if the file changed since.
- **Every AI can read it.** Synthra adds a short block to `AGENTS.md` that points other tools at the same files.
- **One set of rules for every AI.** A new project's `AGENTS.md` starts with a short rules starter (Build & test, Conventions, Key decisions, Gotchas) for the rules your team agrees on. Codex, Cursor, Copilot and Gemini CLI read it directly. Claude Code reads it through an `@AGENTS.md` line in Synthra's `CLAUDE.md` block, so the rules work even though the project also has a `CLAUDE.md`. Rules you already keep in `CLAUDE.md` stay there.

### Claude learns

- **Broad skills, not one per task.** When Claude learns something worth keeping, it takes the first step that fits: improve the skill it used, improve an existing skill for the same kind of work, add a topical side file (`references/<topic>.md`) to that skill, and only then write a new skill, named for the kind of work. A skill is a folder: `SKILL.md` holds the rules every task needs, and `references/`, `templates/` and `scripts/` hold the detail. Skills live in this project (`.claude/skills/`) or in every project (`~/.claude/skills/`).
- **Your own skills too.** Claude may improve skills you wrote by hand, with a patch or a side file. It never rewrites them and never claims them as Synthra's, and every such change waits for your OK. Skills an installer put there (`npx skills`) stay read-only.
- **Updates for installed skills.** **Check for updates** in the Capabilities tab compares each skill you installed with `npx skills` against its GitHub repo, with one request per repo. GitHub allows 60 an hour without a login; past that, Synthra uses your GitHub CLI login (`gh auth login`) or `GITHUB_TOKEN`. **See changes** shows your `SKILL.md` next to the new one, names the other files the update touches, and warns when you changed the skill yourself. **Update** (one skill, or a whole repo) runs `npx skills update <names> -g -y` in a terminal, so the installer stays the only one that writes what it installed. **Don't update** keeps a skill at its version. A skill not installed with `npx skills` (yours, Synthra's, or one copied by hand) is never touched.
- **You decide.** A new or changed skill waits in the extension's **Learning** tab. See the change, then Approve or Reject. A merge comes as one card with Approve all.
- **A gentle reminder.** After a long stretch of work (25 tool calls), Synthra asks Claude whether the work taught something a skill should hold. "No skill to save" is a normal answer.
- **The Curator** keeps skills tidy. Once a week it marks skills Synthra wrote that nobody used for 14 days, and offers to archive the ones unused for 30. Nothing is deleted: add a skill to your favorites to keep it, or restore it any time.

### Claude writes safer code

- `find_symbol` and `duplicate_symbols` show code that already exists, before Claude writes it again.
- `blast_radius` shows the callers and tests a change can break.
- The graph rescans about a second after your edits settle, so the tools never serve stale code.

---

## What it saved (a real measurement)

One controlled before-and-after on a real production project: the same 3-reply walkthrough of WebSocket auth across 4 files, the same prompt, the same Opus model.

| Setup | Cost per session |
|---|---|
| Plain Claude Code | **$7.97** |
| Synthra with the MCP fixes (v0.1.6) | **$4.26** (46% less) |
| Synthra with the full graph tools (v0.1.7+) | **$2.05** (74% less) |

Savings depend on the work. A refactor leans on the graph much more than a markup or CMS session. The [dashboard](#the-dashboard) shows your own spend, so you can compare for yourself.

---

## The extension

| Tab | What you see |
|---|---|
| **Learning** | Skills waiting for your OK, with why Claude wants them and the change (a merge comes as one card). The Curator's stale and archived skills, with Add to favorites and Restore. |
| **Memory** | The project memory, the notes about you, and the session notes for this branch. |
| **Capabilities** | Every skill, agent, connected tool (MCP server) and plugin Claude Code can use, in sections you can fold: this project, yours, each GitHub repo you installed skills from (`npx skills`), and each plugin. Chips: **Made by Synthra**, **Favorites** and **Updates**. Each skill shows how often it was used and its side files. Its ⋯ menu opens, edits, stars, merges or deletes it (a delete moves it to the archive, so Restore brings it back). **Check for updates** asks GitHub which installed skills have a newer version (see below). |
| **Agents** | The helper agents Claude started this week, and the task it gave each one. |
| **Settings** | The memory and skill reminders, the memory size limits, skill approval and the Curator. **Back up** and **Restore** for a new device. |

The status bar item shows whether Synthra runs. Click it to open the dashboard. When it is yellow or red, it lists what is wrong and offers **Repair**. Technical notes for the extension are in [`docs/EXTENSION.md`](./docs/EXTENSION.md).

---

## The dashboard

Live at **http://127.0.0.1:8901** (or the next free port up to 8910). In the extension, click the Synthra item in the status bar.

One dashboard for every project. On the left: every project Synthra knows, the ones used this week first, each with a dot (works, needs a look, quiet) and what it cost. Any window's dashboard shows any of them, and opens on that window's project. **All projects** shows the totals, the health of each project, and cost and code lookups per project. The page uses the full width of the window.

It answers five questions, for this week or this month:

- **Is it working?** When each hook last ran in each project, and whether its hook scripts are current. A hook that stops quietly shows up here, with a plain-words reason and a **Fix hooks** button (it rewrites that project's hooks, the same step `syn .` runs).
- **Is it helping?** How Claude found code: from Synthra's map, by reading whole files, or with a search, week by week. Plus the terminal searches the map could have answered: the place to improve Synthra next.
- **Learning:** skills Claude wrote (live, waiting for your OK, stale, archived), the most used and the never used, and how often a skill reminder led to a skill.
- **Memory:** how full `MEMORY.md` and `USER.md` are, session notes whose file changed since, and how often a memory reminder led to a save.
- **Cost:** spend at API prices against the last period, the model mix and the most expensive replies. On a Claude plan you pay the plan, not this.

And two dialogs:

- **Report:** runs the doctor checks and shows the result (often that alone is the fix). One click copies a redacted diagnostic (home paths become `~`), and two buttons open GitHub's bug and feature forms. Nothing is sent anywhere by itself.
- **FAQ:** what the numbers mean.

---

## Supported languages

**Full symbol extraction** with tree-sitter (functions, classes, methods, types, imports, call edges):

- **TypeScript / JavaScript:** `.ts` `.tsx` `.cts` `.mts` `.js` `.jsx` `.cjs` `.mjs`
- **Python:** `.py` `.pyi`
- **Svelte** `.svelte` · **Vue** `.vue` (`<script>` blocks parsed as TS)
- **Go** `.go` · **Rust** `.rs` · **Java** `.java` · **Kotlin** `.kt` `.kts`
- **PHP** `.php` · **Ruby** `.rb`
- **C** `.c` `.h` · **C++** `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx`
- **C# / .NET** `.cs`
- **Dart** `.dart`

**HubL / HTML** (`.html`, `.hubl`) is read with patterns: `{% macro %}` becomes a function, `{% block %}` a component, `{% include/extends/import %}` an import.

**Everything else** (CSS, JSON, YAML, Markdown and so on) is indexed by content, so keyword search still finds it, without symbol-level detail.

---

## Supported systems

| System | Status |
|---|---|
| **Windows** | ✅ Tested on every change. PowerShell hooks. |
| **Linux** | ✅ Tested on every change. Bash hooks; needs `jq`. |
| **macOS** | ⚠️ Should work (the same Bash hooks as Linux; needs `jq`), but nobody tests it yet. [Tell us](https://github.com/jefuriiij/synthra/issues) how it goes. |

| You need | Why |
|---|---|
| **Node 18+** | Synthra is plain Node. |
| **The `claude` CLI on PATH** | Synthra registers its MCP server through it, so Claude Code sees the tools. |
| **`jq`** (macOS and Linux) | The Bash hooks read JSON with it. Without it they do nothing. `brew install jq` or `apt install jq`. |

No extra API key and no network service: everything runs on your computer. Not sure the setup is healthy? Run **`syn doctor`**.

---

## MCP tools

Fifteen tools over HTTP MCP (named `mcp__synthra__*`). Claude calls them instead of searching and reading whole files:

| Tool | Purpose |
|---|---|
| `graph_continue(query)` | The context pack for a question: a confidence label, the files, signatures and top bodies. |
| `graph_read(target)` | The source of `file.ts` or `file.ts::Symbol`. A symbol read also lists what it calls and who calls it. |
| `graph_register_edit(files)` | Tells Synthra which files Claude edited, so they rank higher and nothing stale is served. |
| `context_remember(text, kind)` | Saves a decision, task, next step, fact or blocker for this git branch, in `.synthra/`. |
| `context_recall(kind?)` | Reads the saved notes (this branch by default). |
| `memory(target, action \| operations)` | Reads or changes the knowledge files: `project` is `.synthra/MEMORY.md`, `user` is `~/.synthra/USER.md`. Refuses past the size limit and anything that looks like a secret. |
| `skill_manage(action, …)` | Keeps skills broad: `list`, `view` (with `file_path` for a side file), `patch`, `write_file` / `remove_file` (side files under `references/`, `templates/`, `scripts/`), `edit`, `create` (only for a new kind of work, with a reason), `archive` (after a merge, with `absorbed_into`). Synthra's skills take any change, your own take patches and side files only, installed ones are read-only. Always after a `view`. By default each change waits for your OK. |
| `recent_activity(since_ms?)` | What you just saved, switched or changed. |
| `count_tokens(text)` | A rough token count (characters / 4). |
| `blast_radius(target, depth?)` | What a change can break: dependent files, or the callers and tests of a `file::symbol`. |
| `dead_code(limit?)` | Files nothing imports and no test touches (entry points excluded). |
| `find_symbol(name)` | Finds existing code by name, before Claude writes a new copy. |
| `duplicate_symbols(limit?)` | Names defined in more than one file. |
| `call_path(from, to, depth?)` | The shortest chain of calls from one symbol to another. |
| `route_task(task)` | Which installed agent or skill fits a task, and which model to run it on (the Dispatcher). |

### In Codex

Run **`syn codex`** once. Codex then starts `syn mcp` in each session, and `syn mcp` finds the project's Synthra server from the folder Codex runs in, so one setup covers every project Synthra has mapped. The tools that only read (the map, `blast_radius`, `find_symbol` and the others) run without an approval prompt; the ones that write (`memory`, `skill_manage`, `context_remember`, `graph_register_edit`) ask first. Synthra's server must be running for the project: open it in VS Code with the extension, or run `syn .`. Codex already reads the rules and knowledge in `AGENTS.md`.

`syn codex` also adds three hooks to Codex's global `~/.codex/hooks.json` (other hooks there stay as they are). Codex asks you to trust new hooks once: type `/hooks` in Codex and trust Synthra's three.

| Hook | What it does in Codex |
|---|---|
| `SessionStart` | Gives Codex the project memory, the notes about you and the "since you were last here" summary. Again after a compaction. |
| `PreToolUse` (shell) | Records searches like `rg` for the dashboard. Codex has no Grep or Glob tool, so Synthra never blocks a search there. |
| `Stop` | Logs the turn's tokens and how much of your Codex limits is used, and adds the memory and skill reminders. |

The dashboard shows Codex replies, tokens and limits next to Claude's. They are never part of the spend: a Codex plan is a flat fee, and Synthra has no GPT prices.

---

## Commands

```bash
syn .                     # Scan, start the MCP server and dashboard, install hooks,
                          # register MCP. Runs until Ctrl+C.
syn . --launch-cli        # Also start the `claude` CLI in this terminal.
syn . --resume <id>       # Resume a Claude session (needs --launch-cli).
syn . --full              # Re-parse every file, ignoring the cache.
syn scan [path]           # Scan only: build the graph. (--full works here too)
syn serve [path]          # Start only the MCP server.
syn dashboard [path]      # Start only the dashboard (localhost:8901).
syn codex                 # Give Codex Synthra's tools and hooks (once per machine).
                          # --remove takes them out again.
syn mcp                   # The tools over stdin/stdout, for Codex. Codex runs it.
syn hook <event>          # One Codex hook. Codex runs it.
syn doctor [path]         # Check this project's Synthra setup.
syn doctor --report       # A redacted diagnostic to paste into a GitHub issue.
syn remove [path]         # Take Synthra out of a project. Asks [y/N]; --yes skips it.
                          # Your own .gitignore lines, CLAUDE.md text and hooks stay.
syn backup [file]         # Save your skills for all projects, USER.md, favorites and
                          # history to one JSON file, for a new device.
syn restore <file>        # Merge a backup in: adds what is missing, never overwrites
                          # (a skill that differs waits in the Learning tab).
```

### Moving to a new device

Project skills and `.synthra/MEMORY.md` travel with each project's git repo. Everything else Synthra keeps lives on one machine, so take a backup: **Back up...** in the Settings tab, or `syn backup`. On the new device, **Restore from backup...** (or `syn restore <file>`) adds the skills that are missing, combines the notes about you, favorites and history, keeps any setting already set there, and moves paths from the old home folder to the new one (Windows, macOS and Linux). A skill that differs from the new device's copy waits in the Learning tab, so nothing is overwritten. Installed skills (`npx skills`) come back from their source with one **Reinstall** button. The file holds your notes about yourself: keep it private.

---

## How it works

### Hooks

Synthra installs five Claude Code hooks in `.claude/settings.local.json`:

| Hook | What it does |
|---|---|
| **SessionStart** | Loads the context pack and the knowledge files into the session. |
| **PreToolUse** | Search stopping for Grep and Glob; watches Bash searches; counts skill use for the Curator. |
| **PreCompact** | Loads the context pack again when Claude Code compacts the chat. |
| **Stop** | Logs the reply's tokens, refreshes `.synthra/CONTEXT.md`, and sends the memory and skill reminders. |
| **UserPromptSubmit** | The Dispatcher (quiet by default, see below). |

The hooks find the project through Claude Code's `CLAUDE_PROJECT_DIR`, so they keep working when Claude moves into a subfolder.

### Search stopping

When Claude uses its **Grep** or **Glob** tool for something the graph already knows well, Synthra stops the search and hands Claude the answer instead: the exact `graph_read("file::symbol")` targets and their signatures. It lets the search through when the graph is not confident, or when you just edited a matching file.

Claude often searches through the terminal instead (`grep`, `rg`, `cat` in Bash). Synthra only **watches** those, and never stops them, because Claude uses the terminal for much more than searching. So on many setups search stopping rarely fires, and the dashboard shows a saving only when it did.

### The Dispatcher

Each prompt is scored against every installed agent and skill, your project's languages and a difficulty estimate, to pick a best-fit agent, model and skill.

**It runs quietly by default.** It records what it would suggest and adds nothing to the chat. When suggestions were on, people followed them in 2 of 390 prompts (1.2%), so they cost context for almost no gain.

- **`route_task(task)`** always answers when you ask: a ranked report with a model suggestion.
- Hard tasks (races, leaks, migrations, security and so on) are marked to stay on your main model.
- `SYN_ROUTE_HINTS=1` turns the suggestions back on, `SYN_ROUTE_MIN_SCORE` (default 5) sets how sure it must be, and `SYN_NO_ROUTE=1` turns it all off.

---

## What Synthra writes

```
your-project/
├── .gitignore                   # adds .synthra-graph/ and .mcp.json (with comments)
├── .mcp.json                    # the 'synthra' MCP entry, so the IDE sees it (gitignored by default)
├── CLAUDE.md                    # a block between <!-- synthra-policy v11 BEGIN/END --> markers; it imports AGENTS.md
├── AGENTS.md                    # the project's rules (a starter in a new project), then a block between <!-- synthra-agents v1 BEGIN/END -->
├── .claude/
│   ├── settings.local.json      # the 5 hooks
│   ├── hooks/                   # synthra-prime, -pre-tool-use, -pre-compact, -stop, -route
│   └── skills/                  # project skills Claude wrote (after your OK)
├── .synthra-graph/              # GITIGNORED: machine-local state
│   ├── info_graph.json · symbol_index.json
│   ├── token_log.jsonl · gate_log.jsonl · route_log.jsonl · nudge_log.jsonl · activity.jsonl
│   ├── heartbeat.json           # when each hook last ran, for the dashboard
│   └── mcp_port
└── .synthra/                    # IN GIT: the team's shared memory
    ├── MEMORY.md                # what every AI should know about the project
    ├── context-store.json       # session notes (default branch)
    ├── CONTEXT.md               # a readable summary the Stop hook writes
    ├── branches/<name>/         # session notes for other branches
    └── skills-archive/          # project skills archived (the Curator, a merge, or a delete)
```

In your home folder, outside every repo:

- `~/.synthra/USER.md`: the notes about you.
- `~/.synthra/settings.json`: the Settings tab.
- `~/.synthra/skills/`: skill proposals waiting for your OK, the history of every skill change, use counts, your favorites, and the archive.
- `~/.synthra/projects.json`: every project Synthra ran in, for the dashboard.
- `~/.claude/skills/`: skills for every project that Claude wrote (after your OK).

**Synthra plays well with other tools.** It writes only inside its own folders, its own `synthra` entry in `.mcp.json`, and its own marked blocks in `CLAUDE.md` and `AGENTS.md`. It finds its own hooks by their script path, so it never touches anyone else's. `syn remove` shows it: your own text and hooks stay. If another tool writes to the same `token_log.jsonl`, the dashboard drops the duplicate entries.

---

## Configuration

Everything works without setup. The everyday settings are in the extension's **Settings** tab, or in `~/.synthra/settings.json`. An environment variable wins over the file. All of these are optional:

| Variable | Default | Purpose |
|---|---|---|
| `SYN_MCP_PORT` | (auto 8080 to 8099) | Pin the MCP server port |
| `SYN_DASHBOARD_PORT` | `8901` | Dashboard port (tries up to 8910) |
| `SYN_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `SYN_CLAUDE_BIN` | `claude` | Where the `claude` binary is |
| `SYN_MEMORY_CHARS` | `3500` | Size limit of `.synthra/MEMORY.md` |
| `SYN_USER_CHARS` | `2000` | Size limit of `~/.synthra/USER.md` |
| `SYN_USER_MEMORY` | `~/.synthra/USER.md` | Where USER.md lives |
| `SYN_MEMORY_NUDGE_EVERY` | `10` | Remind Claude to save what it learned after this many replies; `0` turns it off |
| `SYN_SKILL_APPROVAL` | `1` | `0` lets new and changed skills go live at once, without your OK. Changes to skills you wrote yourself, and to a skill's scripts, always wait. |
| `SYN_SKILL_NUDGE_EVERY` | `25` | Ask Claude whether its work taught something a skill should hold after this many tool calls; `0` turns it off |
| `SYN_CURATOR` | `1` | `0` turns the weekly Curator off ("Run now" still works) |
| `SYN_ROUTE_HINTS` | _(unset)_ | `1` lets the Dispatcher add suggestions to the chat again |
| `SYN_MAP_TOOLS_LOADED` | `0` | `1` keeps the three map tools (`graph_continue`, `graph_read`, `find_symbol`) loaded in every Claude session instead of behind tool search; takes effect when Synthra next starts |
| `SYN_ROUTE_MIN_SCORE` | `5` | How sure the Dispatcher must be (higher is quieter) |
| `SYN_NO_ROUTE` | _(unset)_ | `1` turns the Dispatcher off, logging included (`route_task` still works) |
| `SYN_NO_AUTOREINDEX` | _(unset)_ | `1` stops the rescan after edits |
| `SYN_NO_BASH_OBSERVE` | _(unset)_ | `1` stops watching Bash searches |
| `SYN_NO_UPDATE_CHECK` | `0` | `1` skips the daily update check |
| `SYN_DASHBOARD_DEDUPE` | `1` | `0` shows every raw token-log entry |
| `SYN_DASHBOARD_RECENT_N` | _(unset)_ | Recent replies in the dashboard's raw `/data` payload (500 when unset) |
| `SYN_ACTIVITY_LOG_MAX_BYTES` | `524288` | Size cap for `activity.jsonl`; `0` removes the cap |

More tuning knobs (read budgets, cache times, hint size) are in `src/shared/config.ts`.

---

## Updates

Every `syn .` asks npm for a newer version (2-second timeout, quiet when offline). When one is out:

- **In a terminal:** `Synthra X.Y.Z is available (you have A.B.C). Update now? [y/N]` before the scan. `y` installs it, Enter skips.
- **Not in a terminal** (CI, piped input): a one-line hint, no question.
- **Off:** `SYN_NO_UPDATE_CHECK=1`.

After an update, Synthra prints what changed from [`CHANGELOG.md`](./CHANGELOG.md), then asks you to run `syn .` again. The extension's own changes are in [`extension/CHANGELOG.md`](./extension/CHANGELOG.md), and on its store page.

---

## Report a bug or ask for a feature

Click **Report** on the dashboard, or run **`syn doctor --report`**. Copy the redacted diagnostic and paste it into a [GitHub issue](https://github.com/jefuriiij/synthra/issues). No telemetry: you choose what to share.

---

## Development

```bash
git clone https://github.com/jefuriiij/synthra
cd synthra
npm install
npm link              # `syn` on your PATH; rebuilds show up at once
npm run build         # the dashboard UI, then tsup into dist/
npm run dev           # tsup --watch
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run check         # biome lint and format check
```

How the pieces fit is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), the HTTP routes and hook payloads are in [`docs/PROTOCOL.md`](./docs/PROTOCOL.md), and milestones are in [`ROADMAP.md`](./ROADMAP.md).

---

## License

[MIT](./LICENSE). Fork it and ship it; just keep the attribution. A link back is welcome if Synthra ends up in your own tool, but not required.
