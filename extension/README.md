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

## Status bar

| Item | Meaning |
|---|---|
| `$(database) Synthra 786` | Running — 786 symbols indexed. Click to open the dashboard. |
| `$(sync~spin) Synthra` | Starting. |
| `$(circle-slash) Synthra` | Not running. Click to start. |
| `$(warning) Synthra` | Failed — click for the log. |

Hover any of them for the MCP port, dashboard URL, and graph stats.

## Commands

- **Synthra: Start for this project**
- **Synthra: Stop**
- **Synthra: Restart**
- **Synthra: Open dashboard**
- **Synthra: Show log**
- **Synthra: Run doctor** — opens a terminal running `syn doctor`

## Settings

| Setting | Default | What it does |
|---|---|---|
| `synthra.autoStart` | `true` | Start automatically on folder open. |
| `synthra.requireExistingProject` | `true` | Only auto-start where Synthra has run before (the folder has `.synthra-graph/` or `.synthra/`). |
| `synthra.path` | `syn` | Path to the `syn` executable. |
| `synthra.showDashboardNotification` | `false` | Toast the dashboard link on every start. |

### Why `requireExistingProject` defaults to on

Auto-starting in *any* folder would bootstrap Synthra into repos you never opted into — appending to `.gitignore`, adding a policy block to `CLAUDE.md`, and writing hooks into `.claude/`. That's a lot of uninvited edits to someone else's repo. So auto-start only fires where Synthra already lives; the **Start for this project** command is the opt-in for a new folder.

## Opening the same project in two windows

Safe. Synthra enforces one server per project itself (v0.26 ownership records) — the second window's `syn` detects the live owner, reports `alreadyRunning`, and the extension adopts its port instead of binding a rival.

## Install

**From a `.vsix`:**

```bash
# VS Code
code --install-extension synthra-vscode-0.1.0.vsix

# Antigravity (note: NOT the `code` command)
antigravity --install-extension synthra-vscode-0.1.0.vsix

# Cursor
cursor --install-extension synthra-vscode-0.1.0.vsix
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
