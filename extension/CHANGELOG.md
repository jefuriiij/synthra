# Changelog

What changed in the Synthra extension, newest first. For the full technical
list, see the [Synthra changelog](https://github.com/jefuriiij/synthra/blob/main/CHANGELOG.md).

## Unreleased

These come with the next update of the Synthra engine.

- **Fixed: Synthra lost track of your project in subfolders.** When Claude
  moved into a subfolder of your project, Synthra stopped counting replies on
  the dashboard and stopped its memory and skill reminders. It now always finds
  your project. Reopen the folder once after the update.
- **A new dashboard.** The page you open from the status bar is now a report
  card. It shows whether Synthra works in each project (with a **Fix hooks**
  button when it doesn't), how Claude found code, how skills and memory are
  used, and what the work cost. Skills, agents and tools live in this
  extension, so the dashboard no longer lists them.

## 0.33.1 (2026-10-02)

- **Install Synthra in one click.** If the Synthra engine is not on your
  computer yet, the extension shows an **Install Synthra** button. It installs
  the engine, then starts it for your project. Without Node.js, it tells you
  where to get it.
- **A new store page** with pictures of each tab.
- The skill reminder has its own on/off switch in **Settings**.

## 0.33.0 (2026-10-02)

Synthra learns.

- **A sidebar and a large panel** with five tabs:
  - **Learning:** skills Claude wrote, waiting for your OK. See the change, then
    approve or reject it. The Curator's stale and archived skills are here too.
  - **Memory:** what every AI should know about the project, your own notes,
    and the session notes for this branch.
  - **Capabilities:** every skill, agent, connected tool and plugin Claude Code
    can use. Click one to open it.
  - **Agents:** the helper agents Claude started this week.
  - **Settings:** the memory and skill reminders, the memory size limits, skill
    approval and the Curator.
- Open the large panel with the **Synthra button** at the top right of any
  open file.

## 0.31.1 (2026-09-23)

- The health light is up to date as soon as you open a project.
- A warning popup no longer holds up the rest of the extension.

## 0.31.0 (2026-09-23)

- **A health light.** The status bar item turns yellow or red when something is
  wrong with Synthra, and lists the problem when you point at it. Click it to
  see every check, with a **Repair** button.
- **Updates.** The extension tells you when a new Synthra is out and offers to
  install it.
- New commands: **Show health**, **Repair** and **Check for updates**.

## 0.30.0 (2026-09-19)

- First release. The extension starts Synthra when you open a project and
  stops it when you close the window. The status bar shows whether it runs.
