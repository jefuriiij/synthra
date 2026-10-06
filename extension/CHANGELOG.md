# Changelog

What changed in the Synthra extension, newest first. For the full technical
list, see the [Synthra changelog](https://github.com/jefuriiij/synthra/blob/main/CHANGELOG.md).

## 0.37.0 (2026-10-07)

These come with Synthra 0.39.0. The extension offers the update, or run
`npm install -g @jefuriiij/synthra`.

- **One dashboard for every project.** The dashboard you open from the status
  bar now lists all your projects on the left and shows any of them, or all
  of them, across the full width of the window. It opens on this window's
  project.
- **Clearer approval setting.** With "New skills wait for my OK" off, the
  Learning tab now says that changes to skills you wrote yourself, and to
  scripts, still wait for your OK.

## 0.36.1 (2026-10-04)

These come with Synthra 0.38.1. The extension offers the update, or run
`npm install -g @jefuriiij/synthra`.

- **Fixed: Check for updates said "Everything is up to date" when GitHub
  refused to answer.** It now says it couldn't check, keeps the updates it
  found before, and uses your GitHub CLI login (`gh`) when GitHub's hourly
  limit is used up.

## 0.36.0 (2026-10-04)

These come with Synthra 0.38.0. The extension offers the update, or run
`npm install -g @jefuriiij/synthra`.

- **Updates for installed skills.** In Capabilities, **Check for updates**
  finds newer versions of the skills you installed with `npx skills`. See
  what changed next to your copy, then update one skill or a whole repo, or
  set a skill to **Don't update**.
- **A section for each repo.** Installed skills are grouped by the GitHub repo
  they came from, in sections you can fold, with a link to the repo.

## 0.35.0 (2026-10-04)

These come with Synthra 0.37.0. The extension offers the update, or run
`npm install -g @jefuriiij/synthra`.

- **Back up and restore** in the Settings tab: save your skills for every
  project, your notes about yourself, favorites and history to one file, and
  restore it on a new computer. Restore adds what is missing and never
  overwrites: a skill that differs waits in the Learning tab for your pick, and
  **Reinstall** brings back the skills you installed with `npx skills`.

## 0.34.0 (2026-10-03)

These come with Synthra 0.36.0. The extension offers the update, or run
`npm install -g @jefuriiij/synthra`.

- **A menu on every skill.** In Capabilities, the ⋯ next to a skill opens,
  edits, stars, merges or deletes it. Delete asks first and moves the skill to
  the archive, so Restore in the Learning tab brings it back.
- **Made by Synthra and Favorites.** Two new chips show the skills Synthra
  wrote and the ones you starred. A favorite Synthra wrote is never archived.
  This takes the place of Pin.
- **More on each skill:** how often it was used, when last, whether it is
  installed, linked or unused, and the files that come with it.
- **Merge narrow skills.** Pick two or more and Synthra puts a ready request
  on your clipboard for Claude Code. Claude writes one broader skill, and the
  whole merge comes to the Learning tab as one card with Approve all.
- **Clearer changes in Learning:** a change to one of your own skills says
  so, and a new support file shows its path.

## 0.33.2 (2026-10-02)

These come with Synthra 0.34.0. The extension offers the update, or run
`npm install -g @jefuriiij/synthra`.

- **Fixed: Synthra lost track of your project in subfolders.** When Claude
  moved into a subfolder of your project, Synthra stopped counting replies on
  the dashboard and stopped its memory and skill reminders. It now always finds
  your project. Reopen the folder once after the update.
- **A new dashboard.** The page you open from the status bar is now a report
  card. It shows whether Synthra works in each project (with a **Fix hooks**
  button when it doesn't), how Claude found code, how skills and memory are
  used, and what the work cost. Skills, agents and tools live in this
  extension, so the dashboard no longer lists them.
- **A Changelog tab** in VS Code and the stores: this list.

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
