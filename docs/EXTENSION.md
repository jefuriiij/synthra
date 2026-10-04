# The Synthra IDE extension — developer notes

_The store page is [extension/README.md](../extension/README.md). This page is
the technical one: how the extension starts and stops Synthra, the health light,
updates, every command and setting, and how to build it._

Starts [Synthra](https://github.com/jefuriiij/synthra) automatically when you open a project. No more typing `syn .` in every window.

Works in **VS Code**, **Google Antigravity**, **Cursor**, **Windsurf**, and **VSCodium** — it uses only stock VS Code APIs, so the same build loads everywhere.

## What it does

When you open a folder Synthra already knows, the extension:

1. runs `syn . --managed` in the background for that folder,
2. shows a status-bar item with the live symbol count,
3. shuts the server down **cleanly** when the window closes.

That last point matters more than it sounds. Synthra's hook scripts all end in `catch { exit 0 }`, so if the server dies without releasing `.synthra-graph/mcp_port`, the Moat and the CONTEXT.md refresh stop working **silently** — nothing logs, nothing warns, it just quietly stops helping. The extension never force-kills: it closes the child's stdin and lets `syn` run its own shutdown, only escalating after a grace period.

## Requirements

Synthra itself must be installed and on your PATH:

```bash
npm install -g @jefuriiij/synthra
```

If `syn` lives somewhere unusual, set `synthra.path`.

The health light needs **Synthra 0.32 or later**. With an older `syn` it stays off, and everything else works as before — including the update check, which only needs `syn --version` and npm, and will offer you 0.32.

The sidebar panels need **Synthra 0.33 or later**. With an older `syn` they say so and stay empty.

## Sidebar

Click the Synthra icon in the activity bar to see what Synthra knows about this project:

- **Learning:** the skills Claude wrote or changed. By default each one **waits for your OK**: approve it or reject it with the ✓ and ✗ buttons, and click it to see the change as a diff. Below that: every change of the last 30 days, the skills Synthra wrote, and the **Curator**: once a week it marks the skills Synthra wrote that went unused for 14 days as stale and proposes archiving those unused for 30. Add a skill to your favorites to keep it, restore an archived one, or run the Curator now. A change to one of your own skills says so, a change to a support file names the file, and the changes of one merge come as one card with Approve all. The number on the Synthra icon counts what waits for you.
- **Memory:** first the two files every session loads — **Project memory** (`.synthra/MEMORY.md`) and **About you** (`~/.synthra/USER.md`) — with how full each is. Then the notes Claude saved on this branch with `context_remember`, grouped as current task, blockers, next steps, decisions and facts. A ⚠ marks a note whose file changed since it was saved, so it may be out of date. Click a note to open the file it is about.
- **Capabilities:** the skills, agents, MCP servers and plugins Claude Code can use, grouped by where they come from (this project, yours, plugins), with **Made by Synthra** and **Favorites** chips. A skill shows its tags (Synthra, installed, linked, favorite, unused), how often it was used, and its support files. Its ⋯ menu: Open, Edit, Add to favorites, Merge with others, Delete. Delete asks first and moves the skill to the archive. Merge puts a ready request on the clipboard for Claude Code. Click a name to open its file.
- **Agents:** the helper agents Claude started in the last 7 days, with the task it gave each one, and which ones it uses most.

The panels refresh by themselves when the files behind them change. The ↻ button in each panel's title rescans now.

### The large panel

For more room, open the same content as tabs in an editor: click the Synthra button in the editor's title bar, or the ⧉ button in a sidebar panel, or run **Synthra: Open panel**. It has the same Memory, Capabilities and Agents, laid out like Hermes Studio's panel tabs (there is no chat — Claude Code has that), with a filter box on Memory and Capabilities. It stays open across window reloads. Turn the title-bar button off with `synthra.showEditorButton`.

### Settings

The large panel's **Settings** tab (or the ⚙ button on the sidebar's Memory panel) changes how Synthra behaves:

- **Memory nudge:** on or off, and after how many Claude replies without new notes.
- **Project memory limit** and **About-you limit:** the size limits of `.synthra/MEMORY.md` and `~/.synthra/USER.md`.
- **New skills wait for my OK:** off lets the skills Claude writes go live at once (every change is still listed in Learning).
- **Skill nudge:** after how many tool calls without a skill saved (25 by default) Claude is asked whether the work taught something a skill should hold; 0 = off.
- **Curator:** the weekly tidy, on or off.
- **Suggest agents in chat:** the Dispatcher's hint before Claude answers.

They are saved in `~/.synthra/settings.json`, so they apply to every project and also work when you run `syn` from a terminal. An environment variable (`SYN_MEMORY_NUDGE_EVERY`, `SYN_MEMORY_CHARS`, `SYN_USER_CHARS`, `SYN_ROUTE_HINTS`) wins over the file; the tab then shows the setting as locked. Settings need Synthra running.

The **Backup** card saves what lives on this computer only (skills for every project, `USER.md`, favorites, settings, the skill history) to one JSON file, and restores one on a new device. Restore merges and never overwrites: a skill that differs waits in Learning, and **Reinstall** runs the installer for the installed skills in a terminal. The same works from a terminal with `syn backup` and `syn restore <file>`.

## Status bar

| Item | Meaning |
|---|---|
| `$(database) Synthra 786` | Running and healthy — 786 symbols indexed. Click to open the dashboard. |
| `$(warning) Synthra 786` on **yellow** | Running, but something needs attention. Click for details and **Repair**. |
| `$(error) Synthra 786` on **red** | Running, but something is badly wrong — e.g. your hooks are talking to another project's server. Click for details and **Repair**. |
| `$(sync~spin) Synthra` | Starting. |
| `$(circle-slash) Synthra` | Not running. Click to start. |
| `$(warning) Synthra` | Failed to start — click for the log. |

Hover any of them for the version, MCP port, dashboard URL, graph stats, and any problems.

## Health light

Every serious Synthra failure so far has been **silent**. Hooks registered seven times over, so every Grep went through the Moat seven times. A dead port file that quietly turned every hook into a no-op. `syn doctor` could see these — but nobody runs doctor without a reason.

So the extension runs it for you. It asks the running server for its doctor checks once at start, then every 5 minutes (`synthra.healthCheckMinutes`), and again when you come back to the window. The status bar turns yellow or red when a check fails.

**Repair** restarts Synthra. A managed start *is* `syn .` — it reinstalls hooks, refreshes the CLAUDE.md policy block and re-registers MCP — which is the fix for nearly every doctor warning.

A popup appears only for a problem you haven't been told about yet. A warning you can't fix right now won't nag you on every window open; the status bar keeps telling the truth either way.

## Updates

The CLI's own `Update now? [y/N]` prompt needs a terminal, so it can never appear under the extension — before 0.31 of the extension, opening projects only from the editor meant you were never told about an update.

Now the extension checks npm once per window, in the background, after Synthra is up:

- **A newer version is on npm** → *Update*, *Later*, or *Skip this version*. **Update** stops the server, runs `npm install -g @jefuriiij/synthra@latest` (output in the Synthra log), and starts it again. If npm fails — usually permissions on macOS/Linux — you get a button to run it in a terminal instead.
- **It's installed, but this window still runs the old one** → *Restart*. This is what the other windows say after you update from one of them.

Turn it off with `synthra.checkForUpdates`, or check any time with **Synthra: Check for updates**.

## Commands

- **Synthra: Start for this project**
- **Synthra: Stop**
- **Synthra: Restart**
- **Synthra: Open dashboard**
- **Synthra: Show log**
- **Synthra: Run doctor** — opens a terminal running `syn doctor`
- **Synthra: Show health** — every check, with Repair
- **Synthra: Repair (re-run syn .)**
- **Synthra: Check for updates**
- **Synthra: Refresh panels** — rescans skills and agents for the sidebar
- **Synthra: Open panel** — the large panel, in an editor tab
- **Synthra: Settings** — the large panel's Settings tab
- **Synthra: Install Synthra** — installs the engine (`npm install -g @jefuriiij/synthra`) when `syn` is missing; also offered by a popup and the sidebar

## Settings

| Setting | Default | What it does |
|---|---|---|
| `synthra.autoStart` | `true` | Start automatically on folder open. |
| `synthra.requireExistingProject` | `true` | Only auto-start where Synthra has run before (the folder has `.synthra-graph/` or `.synthra/`). |
| `synthra.path` | `syn` | Path to the `syn` executable. |
| `synthra.showDashboardNotification` | `false` | Toast the dashboard link on every start. |
| `synthra.healthCheckMinutes` | `5` | How often to re-check health while running. `0` = only at start and on window focus. |
| `synthra.checkForUpdates` | `true` | Check npm for a newer Synthra once per window. |
| `synthra.showEditorButton` | `true` | Show the Synthra button in the editor title bar (opens the large panel). |

### Why `requireExistingProject` defaults to on

Auto-starting in *any* folder would bootstrap Synthra into repos you never opted into — appending to `.gitignore`, adding a policy block to `CLAUDE.md`, and writing hooks into `.claude/`. That's a lot of uninvited edits to someone else's repo. So auto-start only fires where Synthra already lives; the **Start for this project** command is the opt-in for a new folder.

## Opening the same project in two windows

Safe. Synthra enforces one server per project itself (v0.26 ownership records) — the second window's `syn` detects the live owner, reports `alreadyRunning`, and the extension adopts its port instead of binding a rival.

## Install

Search for **Synthra** in the Extensions view, or:

```bash
code --install-extension jefuriiij.synthra-vscode
```

- **VS Code:** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jefuriiij.synthra-vscode).
- **Cursor, Antigravity, Windsurf, VSCodium:** from [Open VSX](https://open-vsx.org/extension/jefuriiij/synthra-vscode), which these editors install from.
- **Offline:** download `synthra-vscode-<version>.vsix` from the [GitHub releases](https://github.com/jefuriiij/synthra/releases), then Command Palette → **Extensions: Install from VSIX…**

## Building it yourself

```bash
cd extension
npm install
npm run compile     # esbuild → dist/extension.js, vite → dist/webview/ (the large panel)
npm run check       # tsc for the host, svelte-check for the panel
npm run package     # → synthra-vscode-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host for live testing.

## License

MIT, same as Synthra.
