# Synthra for VS Code / Antigravity / Cursor

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

## Settings

| Setting | Default | What it does |
|---|---|---|
| `synthra.autoStart` | `true` | Start automatically on folder open. |
| `synthra.requireExistingProject` | `true` | Only auto-start where Synthra has run before (the folder has `.synthra-graph/` or `.synthra/`). |
| `synthra.path` | `syn` | Path to the `syn` executable. |
| `synthra.showDashboardNotification` | `false` | Toast the dashboard link on every start. |
| `synthra.healthCheckMinutes` | `5` | How often to re-check health while running. `0` = only at start and on window focus. |
| `synthra.checkForUpdates` | `true` | Check npm for a newer Synthra once per window. |

### Why `requireExistingProject` defaults to on

Auto-starting in *any* folder would bootstrap Synthra into repos you never opted into — appending to `.gitignore`, adding a policy block to `CLAUDE.md`, and writing hooks into `.claude/`. That's a lot of uninvited edits to someone else's repo. So auto-start only fires where Synthra already lives; the **Start for this project** command is the opt-in for a new folder.

## Opening the same project in two windows

Safe. Synthra enforces one server per project itself (v0.26 ownership records) — the second window's `syn` detects the live owner, reports `alreadyRunning`, and the extension adopts its port instead of binding a rival.

## Install

**From a `.vsix`:**

```bash
# VS Code
code --install-extension synthra-vscode-0.31.0.vsix

# Antigravity (note: NOT the `code` command)
antigravity --install-extension synthra-vscode-0.31.0.vsix

# Cursor
cursor --install-extension synthra-vscode-0.31.0.vsix
```

Or: Command Palette → **Extensions: Install from VSIX…**

## Building it yourself

```bash
cd extension
npm install
npm run compile     # esbuild → dist/extension.js
npm run package     # → synthra-vscode-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host for live testing.

## License

MIT, same as Synthra.
