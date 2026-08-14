# Synthra changelog

Notable changes per version. This file ships inside the npm tarball — `syn .`
reads it after an auto-update to show you what changed.

For older versions, see [GitHub Releases](https://github.com/jefuriiij/synthra/releases).

---

## [0.27.1] — 2026-08-14

0.27.0 shipped `synthra-pre-tool-use.sh` with CRLF line endings on macOS and Linux.
bash doesn't tolerate that — it fails while *parsing* the file, before any of the
script's logic runs:

```
PreToolUse:Bash hook error: line 7: $'\r': command not found
line 8: set: +: invalid option
line 36: syntax error: unexpected end of file from `if' command on line 30
```

That hook is registered for the `Grep|Glob|Bash` matcher, so the failure took **all
three tools out of the session**. Its `# Always exits 0` contract couldn't save it;
bash died before reaching the code that guarantees it. And because repairing the
file needs Bash, the agent couldn't fix it either — the one failure mode an agent
can't work around.

**You must re-run `syn .` to pick this up.** Unlike the last two releases, updating
the package is not enough: the CR bytes are in the hook file already written into
your project, and only `installHooks()` rewrites it. One `syn .` per affected
project heals it.

### Fixed

- **POSIX hook scripts are now normalized to LF at the moment they're written**, and
  PowerShell hooks to CRLF, instead of trusting the bytes baked into the bundle.
  This is the only defense that holds no matter what state the machine that built
  the release was in, and it repairs an already-broken install rather than just
  avoiding new ones.

  The bug was build-time contamination, not a source bug. Every `.sh` file in git
  was clean the whole time. `.gitattributes` sets `* text=auto eol=lf`, which makes
  git normalize CRLF→LF when it hashes the working tree — so a CRLF file on disk
  hashes *identical* to its LF blob, produces no content diff, and can never be
  committed. esbuild's text loader reads from disk rather than from git, so it
  inlined the CR verbatim. One editor writing CRLF once (VS Code `files.eol`,
  Notepad, a PowerShell rewrite) silently poisons every build from that machine,
  and `git add --renormalize` is a no-op because the index was never wrong.

- **Stale hooks for the other platform are now pruned on install.** `syn .` only
  ever writes the current platform's extension, so upgrading from a version that
  wrote both — or sharing a checkout across platforms — left orphan `.ps1` files in
  `.claude/hooks/` that nothing but `syn remove` cleaned up. They were never
  registered, but they read as live hooks to anyone auditing that directory.

### Added

- **Two build guards, so this class of bug can't ship again.** `prebuild` strips CR
  from the hook sources before esbuild sees them and warns when it has to; `postbuild`
  (also `npm run verify:eol`) extracts every inlined bash body from the built bundle
  and fails if any carries a CR. The check runs against `dist`, not `src` — a
  source-level check passed for 0.27.0 because the source genuinely was clean.

---

## [0.27.0] — 2026-08-09

Synthra runs two unauthenticated HTTP servers on your machine while you work, and
binding them to `127.0.0.1` is not the boundary it feels like. This release closes
that, and finishes the last three items from v0.26's concurrency audit.

Nothing here changes the hook scripts, so **no need to re-run `syn .`** — updating
the package is enough.

### Security

- **Both servers now refuse requests that aren't addressed to localhost.** Previously
  any page open in your browser could be used to reach them. The technique is DNS
  rebinding: an attacker's page re-points its own domain at `127.0.0.1`, then fetches
  its own origin. The browser considers that same-origin, so no CORS applies and the
  response body is readable by the attacker's script. Binding to loopback doesn't
  help — the browser is *on* your machine and makes the request for them.

  This mattered most for the MCP server, where `POST /mcp` exposes `graph_read` — a
  read-any-file-in-the-project primitive with nothing in front of it. The dashboard
  exposed `/report`, `/data`, and the full body of any installed skill or agent via
  `/arsenal/item`.

  The check keys on the `Host` header because browsers forbid page script from
  setting it, so a rebound request always arrives naming the attacker's domain while
  a real one says `127.0.0.1` or `localhost`. `Origin` cannot do this job: a rebound
  request is same-origin, so no `Origin` is sent at all.

  **If you reach Synthra from another device** — a phone on your LAN, a tunnel, a
  container — list the hostname in the new `SYN_ALLOWED_HOSTS` (comma-separated;
  `dev.box` matches any port, `dev.box:8901` pins one). Refused requests return 403
  and name the variable, so the fix is in the error.

### Fixed

- **Registered edits no longer leak between sessions or grow without bound.** The MCP
  server outlives any single Claude session, and the set of files reported via
  `graph_register_edit` was never cleared — so every later session inherited every
  earlier one's edits, which then rode into that session's saved `filesTouched` as
  though they'd just been worked on. Entries are now timestamped and age out on the
  same 24-hour window already used for the human half of that same question, with a
  cap as a backstop.
- **`.gitignore` and `CLAUDE.md` are no longer read and rewritten as separate steps.**
  Both are yours, and an edit landing in the gap was silently dropped. They now go
  through a new text-mode read-modify-write with the same per-path serialization and
  byte-comparison the JSON state files have used since v0.25 — which means every
  write Synthra makes to a file it doesn't own now takes the same safe path.

### Added

- `SYN_ALLOWED_HOSTS` — extra hostnames both servers will answer on, for LAN, tunnel
  and container setups.

---

## [0.26.0] — 2026-08-08

v0.25 stopped Synthra from destroying a file it had misread. This one is about the
other half: **nothing in Synthra knew who owned a project right now.** No lockfile,
no liveness check, no link between a port and the project it serves. Open a second
`syn` on the same repo — or just close one and open it later — and the pieces
started talking past each other, silently.

Nothing here changes the hook scripts, so **you don't need to re-run `syn .`** for
these fixes to take effect. Updating the package is enough.

### Fixed

- **A second `syn` no longer orphans the first.** It used to bind another port,
  overwrite `.synthra-graph/mcp_port`, and leave the original server running —
  still watching your files and writing state — while every hook talked to
  whichever process wrote the port file last. Synthra now checks whether a server
  for this project is already answering and reuses it: `Synthra is already running
  for this project on :8081 — reusing it.`
- **Shutting one instance down no longer unregisters another's MCP server.**
  `claude mcp remove --scope project` targets a single shared entry in `.mcp.json`,
  not one per process, so the first instance to exit deleted the *other's*
  registration. Claude Code lost the `synthra` MCP server mid-session while a
  healthy server was still listening — both `claude mcp` calls exited 0 and nothing
  was logged. The registration is now only removed when it still points at the
  instance that's leaving.
- **A clean exit no longer leaves a port file naming a dead port.** Nothing ever
  removed `mcp_port`, and every hook script ends in `catch { exit 0 }` by design —
  so a stale file didn't produce an error anywhere, it just quietly switched off
  the Moat and stopped `CONTEXT.md` from refreshing. Both the port file and the new
  owner record are now cleared on shutdown, and only ever by their own owner.
- **Synthra won't adopt a port that another project now serves.** Ports are
  machine-global and `mcp_port` outlives the process that wrote it, so a stale file
  could name a port a *different* project's Synthra had since claimed — sending
  this project's `/context-update` into that project's paths and rewriting **its**
  git-tracked `CONTEXT.md`. `/health` now reports which project root it serves, and
  the answer is checked before anything trusts the port.
- **`syn doctor` diagnoses all of the above.** New `MCP server` check: warns
  `stale port file — nothing is listening on :8081, so every hook silently no-ops`,
  and fails outright when the port belongs to another project.
- **`CONTEXT.md` can no longer lose an entry it just saved.** The narrative was
  rendered from a store read taken *before* a concurrent `context_remember` landed,
  and its write won. The entry survived in the store, so the only evidence was a
  git-tracked file quietly missing a line. Rendering now happens inside the store's
  write window.
- **`graph_read` can no longer return the wrong lines.** It captured a file's
  content, awaited, then looked the symbol up again — so an auto-reindex landing in
  between paired old file content with new line numbers and sliced out whatever
  happened to be there. Every handler that spans an await now pins one graph
  generation. Same fix in `graph_continue`, `/pack`, `/gate` and `/prime`, where
  retrieval and rendering could describe two different graphs.
- **A branch switch no longer starts a scan alongside one already running.** Both
  wrote the same graph files, and whichever finished last won — regardless of which
  had seen the newer tree. Branch switches now go through the same non-overlap
  guard as edit-scans. Relatedly, `.git/HEAD` fires two or three times per checkout
  on Windows, and the branch comparison happened after an await, so one switch
  could be detected twice.
- **A permission granted while `syn .` is starting is no longer discarded.**
  Claude Code writes `settings.local.json` on every approval; the hook installer
  read it, merged, and wrote it back as separate steps.
- **The usage-learning store now repairs itself.** It's a cache of an append-only
  log, but it only replayed that log when it was completely *empty* — so a store
  clobbered by an older writer kept some files, passed the check, and served a
  ranking built on partial history indefinitely. It now replays whenever it's
  behind the log, and merges against what's on disk rather than overwriting it.
- **`~/.synthra/last-seen-version.json`** goes through the same safe read-write
  path as every other state file, and never moves backwards.

### Added

- `.synthra-graph/mcp_owner.json` — who owns this project: port, pid, project root,
  start time, version. Only `syn` reads it. `mcp_port` deliberately stays a bare
  integer, because the hook scripts parse it directly and are only rewritten on
  `syn .`.
- `GET /health` now returns `{ ok, project_root, pid, port }` instead of `{ ok }`.

---

## [0.25.0] — 2026-07-29

Audit of every state-file write in Synthra. It found three ways your data could be
destroyed silently, all sharing one mechanism: **a reader that treated a damaged
file as an empty one, and a writer that then saved that emptiness over it.** Being
graceful about a missing file was right; being graceful about a *damaged* file
quietly deleted things.

### Fixed

- **`.claude/settings.local.json` could be rewritten with only Synthra's hooks.**
  If that file didn't parse — a hand edit, a merge-conflict marker, an interrupted
  write by any tool — the hook installer read it as `{}` and saved it back
  containing nothing but its own entries, discarding every permission you'd
  granted and every hook another tool had installed. It now refuses to touch a
  settings file it can't read, sets a copy aside, and tells you which file and why.
  The hook scripts still get written, so fixing the JSON and re-running completes
  the install.
- **A damaged context store could destroy your memory.** `.synthra/` is
  git-tracked, so this got *committed*. A failed parse read as zero entries, which
  then (a) saved a one-entry store over however many were really there and
  (b) rewrote `CONTEXT.md` to say there were none. A damaged store is now set
  aside intact and nothing is written in its place. Separately, an empty store can
  no longer replace a `CONTEXT.md` that has content — the guard is on the outcome,
  so it also covers a deleted store or a mis-resolved branch.
- **`~/.synthra/projects.json` and `favorites.json` had the same shape of bug** —
  one bad read and the next write persisted a single-entry file. Both refuse now.
- **A corrupt graph refused to start Synthra.** `info_graph.json` is ~900 KB and
  was the likeliest file to be caught half-written, and reading it threw a fatal
  *"Run `syn scan` first"*. The graph is rebuilt from your filesystem, so losing it
  costs seconds — Synthra now rescans automatically instead of telling you to run
  the command it could run itself.
- **Two `syn .` runs at the same moment could lose a project** from the registry.
  Each read the file, each added only itself, and one won. Updates are serialized
  and retried against what actually landed.

### Changed

- **Every state file is now written atomically** — to a temp file, then one rename
  — so a crash or a killed process can no longer leave a half-written file behind.
  That's what produced corrupt state in the first place. Covers the graph,
  `CONTEXT.md`, `CLAUDE.md`, `.gitignore`, `settings.local.json`, `.mcp.json`, the
  hook scripts, the session snapshot, the parse cache and the usage store. Append-only
  `.jsonl` logs are untouched — single small appends whose readers already skip bad lines.
- A file that can't be parsed is moved to `<name>.corrupt-<timestamp>` rather than
  deleted, so it stays recoverable by hand. `syn doctor` will learn to report these.

---

## [0.24.0] — 2026-07-28

### Added

- **Favorite the skills and agents you actually use.** With 100+ of each
  installed, the ones you reach for daily are buried in an alphabetical wall. A
  heart on every skill and agent card now pins it to a **Favorites** row that
  sits directly under `All` in the group panel. Favoriting doesn't move anything
  — a favorited personal skill still shows under `Personal` too, so the row is a
  shortcut rather than a filing decision, and it only appears once you have one.
  MCP servers have no heart: they're config entries with nothing to bookmark.
- Favorites are stored **machine-wide** at `~/.synthra/favorites.json`, next to
  `projects.json`, because skills and agents are installed per-machine rather
  than per-project. Heart something in one project and it's hearted everywhere.
  The file is plain JSON and safe to hand-edit or delete; entries for skills you
  later uninstall are kept rather than pruned, since a "missing" skill is usually
  just a disabled plugin or a project you don't have open.
- New routes `GET /favorites` and `POST /favorites` — the dashboard's first
  write endpoints. The POST takes an explicit boolean rather than toggling, so a
  double-clicked heart is idempotent instead of a coin flip, and it requires
  `content-type: application/json` from a same-origin caller, which is what stops
  a random web page from firing a no-preflight write at your localhost server.
  Favorites are deliberately **browsing-only**: nothing in the routing path reads
  them, so a favorite can never change which agent Claude gets pointed at.

---

## [0.23.0] — 2026-07-28

### Added

- **Command packs get their own group.** Impeccable v4 collapsed 17 separate
  skills into one skill whose 23 commands live inside it as reference files —
  which made `/impeccable polish` unfindable in the Arsenal. Such a skill now
  expands into browsable cards under its own left-panel row (`Impeccable 24`),
  sorted after `Personal` and before the plugins, with the pack's own skill
  leading the row. Searching `polish` finds the command; searching the pack name
  finds all of them. Membership comes from the pack's own command manifest, not
  from globbing its folder — impeccable ships 34 reference files of which only
  23 are commands. A missing or malformed manifest degrades to the parent skill
  alone. One narrow table entry per pack; nothing else is affected.
- **Cards open a detail modal.** Clicking any Arsenal card used to un-clamp two
  lines of description; the file body never left the server. A new
  `GET /arsenal/item` serves one item's full source, and a centered modal shows
  the unclipped description, every frontmatter key, and the complete file text
  as scrollable monospace with a line count and a copy button. Skills and agents
  show their file; MCP entries show type/url (they have no file). The client
  sends only the identity it already has — the server re-resolves name → file
  through its own scan index, so no path ever crosses the wire.

### Fixed

- **Block-scalar frontmatter values were read as `|`.** A skill or agent written
  as `description: |` followed by indented lines showed a bare pipe on its card,
  and the Dispatcher scored it with zero description tokens. Both now read the
  real text. Note for anyone comparing routing logs across this version: newly
  legible descriptions can shift a prompt's routing score.

### Changed

- `counts.skills` now includes expanded pack members, so the Skills tab count
  can exceed the number of `SKILL.md` files on disk.
- The Dispatcher skips pack members — it recommends skills to load, not
  sub-invocations of one, and 23 keyword-dense design commands from a single
  vendor would swamp the shadow-mode follow-rate baseline.

---

## [0.22.0] — 2026-07-25

### Added

- **The Arsenal is a browser now.** With 100+ skills and 100+ agents installed,
  one long scroll wasn't cutting it. A left panel lists every source — `All`,
  `In this project`, `Personal`, then each plugin (`Marketing Skills`, `Figma`,
  `Voltagent Lang`…) with its item count — and clicking one shows just that
  group on the right. Works on all three tabs, the search box filters both
  panes at once (group counts follow along, empty groups disappear), and each
  pane scrolls independently so the page itself stays put.

### Changed

- Layout elements across the dashboard carry `syn-*` class hooks
  (`syn-arsenal-item-grid`, `syn-card-moat`, `syn-sidebar`…) so a region can be
  found by grep or in devtools while editing. They're inert — nothing styles
  them.
- Inside a selected group every card shares the same scope, so the redundant
  scope/plugin badge is hidden there (it still shows under `All`, and a
  disabled item is still marked `off`).

---

## [0.21.0] — 2026-07-24

### Changed

- **Routing hints are now silent by default ("shadow mode").** v0.20's
  instrumentation measured the Dispatcher over 390 real prompts: hints were
  followed **2 times (1.2%)**, and none went to the recommended agent. So it
  stops interrupting. Synthra still scores every prompt and records the verdict
  — the dashboard reports it as *"would have hinted N"* — but injects nothing
  until the numbers say it earned the right to speak. Set **`SYN_ROUTE_HINTS=1`**
  to re-enable injection. `route_task(task)` is unaffected and remains the
  intended way to ask for a recommendation. No hook reinstall needed; updating
  the package is enough.
- **`SYN_ROUTE_MIN_SCORE` default 3 → 5** — a stronger match is required before
  a verdict counts.

### Fixed

- **The Dispatcher stops routing on things you never typed.** Two-thirds of all
  hints (112 of 166) had fired on harness-injected notices — `<ide_opened_file>`,
  `<task-notification>`, `<ide_selection>`. These are now skipped outright and
  never logged, so the route log finally counts only real prompts.
- **File and URL paths no longer pick the agent.** Path-ish words collapse to
  their basename before scoring, which ends a whole family of misroutes:
  `/data/horses` no longer routes to `data-analyst`, a `…\custom modules\x.module`
  path no longer routes to `powershell-module-architect`, and
  `Documents\Windsor Project` no longer routes to `project-manager`.
- **Role words in agent names stop matching casual prose.** Generic tokens
  (manager, developer, tester, data, project, content, api…) no longer earn a
  full name-match, so "i want to test them locally" stops summoning
  `test-automator`.

Replayed against every prompt Synthra had ever logged, these fixes take it from
**166 hints to 1** — and the three misroutes above to zero.

---

## [0.20.0] — 2026-07-15

### Added

- **Dispatcher follow-rate.** The Stop hook now spots actual subagent
  delegations (Task/Agent calls) in the transcript and logs them to
  `delegation_log.jsonl`; the dashboard's Dispatcher card correlates them with
  routing hints and shows `followed X of Y hints (Z exact)` — the honest
  measure of whether the router changes behavior. Hook update lands on your
  next `syn .`.
- **Suspected-false-block metric.** A Moat block followed within 2 minutes by
  a terminal search sharing its query terms is counted as a bypass — the Moat
  card now shows `N bypassed via terminal — suspected false blocks`. Block log
  entries also record their top matched files for later grading.

### Changed

- **The Moat no longer blocks test-file-only matches.** When every top match
  for a query lives in test files and the query isn't about tests, the search
  is allowed — this was the most common false block in the field (a UI-state
  query matching test symbols).

---

## [0.19.0] — 2026-07-06

### Added

- **The dashboard now shows the Dispatcher at work.** A new full-width Overview
  card reads `route_log.jsonl`: how many prompts were scored vs actually hinted,
  the standard/complex difficulty split, your most-recommended agents, and a
  live feed of recent routing decisions (with the recommended agent when one
  fired). The route log itself now records the top agent + model per decision,
  so the card gets richer as you use it.

### Changed

- **Dashboard polish:** hero numbers (spend, savings, Moat blocks, routes)
  animate to their new values on each refresh (and snap instantly under
  reduced-motion); the first load shows a skeleton grid instead of a blank
  page; cards get a subtle border highlight on hover; empty states now say
  what makes their data appear.
- **Model usage is a real chart now.** The hand-drawn donut was replaced with
  a LayerChart donut-with-text: animated arcs, a hover tooltip per model
  family, and the turn total in the center. Same card, same legend, better
  chart.

### Security

- Bumped `hono` to 4.12.28 — fixes a high-severity path-traversal advisory in
  `serve-static` on Windows (Synthra never uses serve-static, so this is
  defense-in-depth, but you shouldn't ship a known-vulnerable version).

---

## [0.18.0] — 2026-07-03

### Added

- **The router judges task difficulty.** Prompts carrying two or more hard
  signals (races, leaks, teardown, migrations, security, performance, …) are
  flagged **complex**: the routing hint now says *plan AND execute on your
  primary model* instead of blanket-recommending sonnet, unpinned agents are
  recommended on opus, and `route_task` reports the verdict on a `Difficulty:`
  line with a matching model policy. A complex verdict always speaks — even
  when no installed agent matches — and every decision lands in
  `route_log.jsonl` so the heuristic can be graded in the field.

### Fixed

- **Routing noise, straight from the first field report.** Generic prose words
  (add/new/app/across/without/…) no longer score; an item must hit a name token
  or two distinct words to rank at all; agents declaring a different ecosystem
  than the project's language fingerprint are penalized out (no more
  `powershell-module-architect` winning a Svelte task via "module"); and
  same-named entries installed twice (personal copy + plugin) are deduped.

---

## [0.17.0] — 2026-07-02

### Added

- **Report an issue (or suggest a feature) straight from the dashboard.** A new
  **Report** button in the sidebar runs the doctor checks live and shows the
  results — often that alone tells you the fix (e.g. "jq missing — hooks silently
  no-op"). One click copies a markdown diagnostic (Synthra/OS/Node versions +
  every check, home paths redacted to `~`), and two buttons open GitHub's bug /
  feature forms — paste and submit. Nothing is ever sent automatically.
- **`syn doctor --report`** — the same copy-pasteable diagnostic from the
  terminal.
- **GitHub issue templates** — the bug form asks for the diagnostic report, so
  every report arrives debuggable.

---

## [0.16.1] — 2026-07-02

### Added

- **Dashboard: a Commands page.** New sidebar entry (below Arsenal) listing every
  `syn` command with its description and flags — including the macOS/Linux note
  that the hooks need `jq`. No more digging through the README to remember
  `syn remove --yes` or what `doctor` checks.

---

## [0.16.0] — 2026-07-02

### Added

- **The Dispatcher — Synthra now routes your tasks.** On every prompt, Synthra
  scores the request against every installed subagent and skill (plus the
  project's language fingerprint) and — when it finds a clear fit — injects a
  one-line hint: *"[Synthra route] This task fits agent 'X' (model: sonnet) +
  skill 'Y'. Plan here first, then delegate execution."* Works for any domain
  your arsenal covers: UI work routes to your frontend agents, security audits
  to your security agents, and so on. Silent when unsure. Disable with
  `SYN_NO_ROUTE`; tune the confidence bar with `SYN_ROUTE_MIN_SCORE`.
- **`route_task` tool** — the on-demand version: ask which installed
  agent/skill fits a task and which model to run it on; returns ranked
  candidates with match reasons.
- **Model policy baked in:** plan on the primary model, delegate execution to a
  subagent on a cheaper one (Sonnet is ~5× cheaper than Opus on every rate).
  Agents that pin their own `model:` are respected; everything else defaults to
  a `sonnet` recommendation.

---

## [0.15.0] — 2026-07-02

### Added

- **Your remembered context now talks back.** Synthra's second brain was
  write-only — decisions and gotchas went in via `context_remember` and never
  resurfaced. Now they appear exactly where they're relevant:
  - `graph_read` of a file (or a symbol in it) shows a `📌 Remembered for this
    file` block with the entries linked to that file.
  - `graph_continue` packs include `Remembered:` lines for entries matching the
    query.
- **Memories know when they might be wrong.** Entries linked to files are now
  *anchored* to those files' content hashes at capture time. When the code
  changes afterwards (tracked live by auto-reindex), every surfacing of that
  entry — graph_read, graph_continue, context_recall — carries
  `⚠ possibly stale — <file> changed since stored`. Old entries without anchors
  keep working and are never flagged; the shared context-store format is
  unchanged (additive optional field).

---

## [0.14.1] — 2026-07-02

### Added

- **Dashboard: copy button beside every Arsenal card name.** One click copies the
  skill/agent/MCP name to your clipboard (with a ✓ flash) — handy for invoking a
  skill or referencing an agent — without toggling the card open.

### Fixed

- **Dashboard: expanding an Arsenal card no longer stretches its neighbors.**
  Opening a skill/agent card made the cards beside it in the same grid row grow
  to matching height — looking expanded while their text stayed clamped until
  clicked. Cards now align to the top of their row, so only the clicked card
  grows and neighbors keep their compact size.

---

## [0.14.0] — 2026-07-02

### Added

- **`syn remove [path]` — cleanly uninstall Synthra from a project.** Ran `syn .`
  in the wrong folder, or just want Synthra out of a repo? `syn remove` reverses
  the bootstrap: deletes `.synthra-graph/` and `.synthra/`, strips the policy
  block from `CLAUDE.md`, Synthra's entries from `.gitignore`, its hooks from
  `.claude/` — **your own content in those files survives**; a file is deleted
  only when nothing else remains. Also deregisters the MCP entry (with a direct
  `.mcp.json` fallback when the `claude` CLI isn't available) and removes the
  project from the dashboard registry. Shows a summary and asks `[y/N]` first;
  pass `--yes` to skip (required when not running in a terminal).

---

## [0.13.1] — 2026-06-24

### Fixed

- **Minified/bundle files are no longer indexed.** Committed vendored plugin JS
  (`*.min.js`, `*.bundle.js`, `*.min.css`, …) has no readable symbols, so indexing
  it only polluted retrieval and caused **useless Moat blocks** on markup-heavy
  projects — a Grep for CSS classes like `nav|menu|toggle` would spuriously match a
  symbol *inside* the minified library and get blocked, only for `graph_continue` to
  then find nothing. The scanner now skips these files (cleaner retrieval, smaller
  graph, no behavior change for real source).

---

## [0.13.0] — 2026-06-24

### Added

- **The resume digest now lists the symbols that changed since your last session.**
  The SessionStart "Since you were last here" primer showed *files* touched; it now
  leads its supporting context with the actual **symbols/signatures** that changed —
  e.g. `src/auth.ts::login (function) — function login(creds: Creds): Promise<...>`.
  Computed from a git diff against the previous session's HEAD (committed **and**
  uncommitted changes), overlapped with the current graph. Best-effort: silently
  omitted in non-git projects.
- **`call_path(from, to)` — trace control flow.** Returns the shortest chain of
  calls from one symbol to another (`handler → service → repo`), so you can see how
  one symbol reaches another. The forward complement to `blast_radius` (callers).
  Each of `from`/`to` is a `file::symbol` target or a bare symbol name when unique.

Both reuse the existing call graph + git — no graph schema change, no new dependencies.

---

## [0.12.0] — 2026-06-24

### Added

- **`find_symbol(name)` — reuse before you re-implement.** Before writing a new
  helper, ask Synthra whether one already exists: `find_symbol` returns every
  exact-name definition (with signatures + ready `graph_read` targets), or — if
  there's no exact match — similarly-named symbols to reuse or extend. "No symbol
  matching … — safe to create" is the green light that it's genuinely new. The
  injected policy now nudges the agent to check first.
- **`duplicate_symbols` — consolidation candidates.** Lists symbol names defined
  in more than one file (functions/classes/types; methods excluded, since shared
  method names are normal). Advisory — duplicates can be intentional; it never
  says "delete."

Both are built on the symbol index (exact name lookup) — no false-positive risk,
no new dependencies.

---

## [0.11.0] — 2026-06-24

### Added

- **`graph_read` now shows which tests cover a symbol.** A symbol read appends a
  `Tests (file-level): …` line listing the test files linked to the symbol's file
  (via the graph's `tests` edges) — so after an edit you run the *right* test
  instead of guessing or running the whole suite. Ordinary source files with no
  linked test get a one-line "none linked" nudge.
- **`blast_radius` is now symbol-aware.** A `file::symbol` target returns the
  exact caller **symbols** that transitively call it (`name → file:line`), plus a
  line naming the test files that guard the impact — the precise view you want
  before a rename. A bare file target keeps the existing file-level dependent
  list. (The `graph_read` "Used by (N)" footer remains the cheap always-on
  direct-caller summary; this is the complete, transitive, on-demand one.)

---

## [0.10.0] — 2026-06-20

### Added

- **Terminal-bypass visibility (observe-only).** The Moat blocks `Grep`/`Glob`,
  but the agent can still explore the codebase through the shell — `rg foo src/`,
  `cat src/x.ts`, `find …` — and every such call is a read the graph could have
  served in ~50 tokens. Synthra now watches `Bash` too: it classifies these
  exploration commands and records each one — with whether the graph could have
  answered it — to `bash_log.jsonl`, surfaced on the dashboard's Moat card as
  "N terminal hunts · M the graph could answer." It is **observe-only — it never
  blocks a Bash command** — so you can measure the leak before deciding whether
  to close it. Conservative by design (it ignores `npm`/`git`/builds, stdin
  filters like `… | grep`, and any command with a redirect). Disable with
  `SYN_NO_BASH_OBSERVE`.

---

## [0.9.0] — 2026-06-20

### Added

- **The graph auto-reindexes edited files mid-session — it never goes stale.**
  Previously the in-memory graph was a snapshot from the last `syn .`: edit a
  file and `graph_read` / `blast_radius` / the dependency footer would keep
  serving the *old* signature, body, and line ranges until the next manual scan.
  Now the running server watches for source changes and, ~1s after edits settle,
  re-runs the incremental scan and hot-swaps the graph in place — so reads always
  reflect what's on disk. The rescan is incremental (only the changed file hits
  tree-sitter; everything else reuses the content-hash parse cache) and debounced
  so a burst of saves coalesces into one rebuild. Tune with
  `SYN_REINDEX_DEBOUNCE_MS` (default `1000`); disable with `SYN_NO_AUTOREINDEX`.

### Fixed

- **In-session rescans (auto-reindex and branch-switch) no longer rewrite your
  `CLAUDE.md` / `.gitignore`.** A rescan now skips the bootstrap step — it only
  rebuilds the graph. This also closes a feedback loop the new auto-reindex would
  otherwise hit (rewriting the watched `CLAUDE.md` on every rescan would retrigger
  the watcher endlessly).
- **`CLAUDE.md` no longer accumulates a blank line on every `syn .`.** The policy
  block patcher is now idempotent — re-running with nothing to change is a true
  no-op instead of appending an empty line above the managed block each time.

---

## [0.8.1] — 2026-06-16

### Changed

- **Dashboard polish.** The Overview is now a tidy bento — equal-height cards,
  with the Savings and Total-spend cards sized to their content and a tall Moat
  spanning the right that scrolls internally. The Arsenal view groups skills,
  agents, and MCP servers into labeled sections by source ("In this project",
  "Personal · this machine", and one per plugin) so a big toolkit is easy to
  scan. Base text bumped to 14px for readability. UI-only; data unchanged.

---

## [0.8.0] — 2026-06-15

### Changed

- **The dashboard is rebuilt on Svelte + shadcn-svelte with a real sidebar.** A
  persistent, collapsible left sidebar (Overview · Arsenal · FAQ) replaces the
  old top-nav + cramped drawer; the **Arsenal is now a roomy first-class view**
  (tabs, filter, expandable cards) instead of a 340px slide-out. Same data, same
  endpoints, same numbers — only the UI changed. The Svelte/Tailwind/Vite
  toolchain is build-time only: it compiles to a single inlined HTML the server
  serves exactly as before, so the installed runtime and zero-config setup are
  unchanged (no new runtime dependencies).

---

## [0.7.0] — 2026-06-15

### Added

- **Dashboard "Arsenal" drawer.** A collapsible panel (toggle in the nav) lists
  everything Claude Code has available to you — **skills, subagents, and MCP
  servers** — scoped project / personal / plugin, each expandable to its
  description (agents also show tools + model). It scans your project `.claude/`,
  your personal `~/.claude/`, and every installed plugin, so you never have to
  drop to the CLI to remember what's in your toolkit. MCP entries are shown as
  name / type / url only — auth headers and tokens are never read into the view.

---

## [0.6.0] — 2026-06-13

### Added

- **`graph_read` now delivers a symbol's dependency surface.** Reading a symbol
  appends a footer built from the call graph: **Depends on** — the symbols it
  calls, each with its full one-line signature and a `graph_read` target, so you
  can edit against real signatures instead of guessing parameter shapes or
  re-reading the callee files; and **Used by** — the names of the symbols that
  call it, so a change's blast radius is visible at a glance. Budgeted via
  `SYN_READ_DEPS_CHARS` (default 900); leaf symbols with no calls add nothing.

---

## [0.5.0] — 2026-06-13

### Added

- **`graph_read` hands you the cheap edit recipe.** Reading a symbol slice now
  ends with the exact targeted `Read(path, offset, limit)` (covering the symbol
  plus a little headroom) that satisfies Claude Code's Edit read-gate, plus a
  "do not re-read the whole file" nudge. A `graph_read` slice doesn't satisfy
  the gate on its own, so editing a symbol used to force a whole-file Read —
  and the same large file would get re-read many times across a session.
  Delivering the recipe at the point of use (not just once in the session
  primer) keeps edits cheap.

### Changed

- **The Moat stops wasting blocks on styling searches.** Grep/Glob patterns for
  CSS custom properties (`var(--brand)`, `--sidebar`), hex color literals
  (`#fff`), and all-kebab class names (`cw-code-chip`) now pass through instead
  of being blocked and redirected to a graph the symbol index can't answer.
  Mixed queries that also name a real symbol still block.

---

## [0.4.1] — 2026-06-10

### Added

- **Claude Fable model family.** Fable turns (`claude-fable-5`, including the
  `[1m]` long-context variant) were bucketed as "Other" in the model donut and
  billed at the Sonnet fallback rates. The dashboard now prices Fable at its
  published rates ($10/M input, $50/M output, $1/M cache read, $12.50/M cache
  write) and gives it its own donut segment, legend entry, turn pill, color,
  and FAQ rate-table column. Historical Fable turns reprice correctly on the
  next dashboard load — cost is computed at read time from the raw model IDs
  in the token log.

---

## [0.4.0] — 2026-06-10

### Changed

- **The Moat's block messages now deliver the answer, not just directions.**
  When the gate blocks a Grep/Glob, the deny reason used to name the relevant
  file paths — and agents responded by Reading those files whole, erasing the
  savings the block was meant to create. The block message now carries
  copy-pasteable `mcp__synthra__graph_read("file::symbol")` targets with
  one-line signatures for the query's best-matching symbols (~300 tokens,
  signatures only), plus a `graph_continue` pointer for the full pack. The
  cheap path is now the path of least resistance. Budget tunable via
  `SYN_GATE_HINT_CHARS` (default 1200 chars). Gate decisions are unchanged —
  only the message got smarter.
- **Policy v7 — full namespaced tool names.** Agents wasted tool-discovery
  round-trips searching for short names like `graph_continue` that don't
  resolve. The CLAUDE.md policy block now states the `mcp__synthra__` namespace
  requirement up front, provides a ready ToolSearch `select:` line for the
  graph tools, and uses the full form in every invocation example. Existing
  policy blocks upgrade automatically on the next `syn .`.

---

## [0.3.1] — 2026-06-09

### Changed

- **Dashboard layout.** The Total-spend (cost) hero now sits beside the Savings
  card in a responsive two-column row at the top of the center column (collapsing
  to one column on narrow viewports), and the new "Hot files" list is height-capped
  with its own scrollbar so a long list never crowds the Moat card beneath it.

---

## [0.3.0] — 2026-06-09

### Added

- **Incremental scanner.** `syn .` now re-parses only the files whose content
  changed since the last scan, reusing cached parses (symbols, imports, calls)
  for everything else via a content-hash parse cache. Rescans of a large repo
  after editing a handful of files are dramatically faster; the resulting graph
  is byte-identical to a full scan. `syn . --full` forces a clean rebuild. This
  makes the long-standing "updated incrementally" claim actually true.
- **Call-graph edges.** Function and method call sites are now captured during
  parsing and resolved (name-based, precision-first: same-file wins, else the
  unique repo-wide symbol; ambiguous/external calls are skipped) into
  symbol→symbol `calls` edges. `blast_radius` therefore surfaces **callers**,
  not just importers and tests — so the impact of changing a function includes
  the code that calls it. Captured across 14 languages (TypeScript, Python, Go,
  Rust, Java, C, C++, C#, plus best-effort Kotlin/PHP/Ruby and Svelte/Vue
  passthrough); this makes the "call relationships" claim honest.
- **Dashboard "Hot files" card.** The dashboard now surfaces the usage-learning
  layer directly: the active project's hottest files by recent, decayed access.
- **Dashboard favicon.** The dashboard tab now carries the Synthra S mark.

### Internal

- The scanner is now under test — directory walker, parser dispatch, a
  per-language symbol/call smoke suite, and the context packer — alongside the
  call-resolution and incremental-equivalence tests. CI runs on Node 24 actions
  with the test matrix on Node 22 (ubuntu + windows).

---

## [0.2.1] — 2026-06-06

### Changed

- **Keyword retrieval is now IDF-weighted (BM25's term-rarity component).** A
  query token that's rare across the repo counts for more than a common one, so
  on a multi-term query the files matching the *specific* terms rank above those
  matching generic ones — instead of every keyword match counting the same. The
  weighting is normalized to the query's mean IDF, so a typical match scores the
  same as before: overall ranking magnitude — and the confidence / Moat gating
  that depends on it — is unchanged. Purely an in-repo ranking refinement, no API
  or data-model change. (TF-saturation / length-norm parts of full BM25 don't
  apply to the deduped top-N keyword representation.)

---

## [0.2.0] — 2026-06-06

### Added

- **Cross-session "second brain" — a resume digest at session start.** Synthra
  now captures a snapshot at session end (open next-steps/decisions, files
  touched, and commits since your last session) and, on the next session, leads
  the SessionStart primer with a budget-bounded **"Since you were last here"**
  digest. A fresh session arrives already oriented instead of re-paying tokens
  to rediscover recent work. The snapshot lives in `.synthra-graph/`
  (machine-local) and falls back to the normal primer when there's nothing to
  show.
- **Usage learning — retrieval that gets smarter the more you use it.** Files
  you actually open (`graph_read`) or edit (`graph_register_edit`) accrue a
  time-decayed weight (7-day half-life), and retrieval gives genuinely "hot"
  files a small, capped re-rank boost. It's anchored to files that already match
  your query and capped below the existing seed boost, so it sharpens ranking
  without ever overriding relevance. Purely local, per-developer; degrades to
  the exact prior ranking when there's no usage history. Tunable via
  `SYN_LEARN_HALFLIFE_DAYS` and `SYN_LEARN_BOOST_CAP`.
- **CLAUDE.md policy v6** — teaches the assistant to trust the resume digest and
  pull concrete next steps via `context_recall({kind:"next"})` instead of
  re-exploring the codebase.

### Fixed

- **`pre-compact.sh` now parses the primer with `jq`, not a greedy `sed`
  capture** — completing the `jq` migration across all four bash hooks (matches
  the Stop/Prime/PreToolUse fixes). The multi-line resume digest contains quotes
  and newlines the old `sed` capture would have mangled.

### Internal

- **CI (GitHub Actions), Biome (lint + format), and coverage** added. CI runs on
  an ubuntu + windows matrix, so cross-platform hook regressions are caught
  automatically. `.gitattributes` enforces LF line endings on every platform.

---

## [0.1.25] — 2026-06-06

### Fixed

- **PreToolUse (Moat) bash hook now parses the gate response with `jq`, not a
  greedy `sed` capture (issue #13).** `src/hooks/scripts/pre-tool-use.sh`
  extracted the block `reason` via `sed -n 's/.*"reason"…\(.*\)".*/\1/p'`. The
  greedy `\(.*\)"` capture over-ran into the trailing JSON fields, and because a
  block `reason` legitimately contains double quotes (it quotes the searched
  query, e.g. `"login"`), the captured text broke the deny JSON when embedded
  raw in the output heredoc — so on a real block Claude Code received malformed
  `hookSpecificOutput` and the deny was silently dropped. The hook now reads
  `.decision` / `.reason` with `jq -r '… // empty'` and re-emits the deny object
  with `jq -nc --arg` (correct escaping), behind a `command -v jq` guard that
  silently no-ops when `jq` is absent — mirroring the Stop/Prime hooks fixed in
  #1. Gate/Moat decision logic is unchanged. This completes the `jq` migration
  across all three bash hooks (the last v0.2 item). Verified end-to-end under
  bash on Linux: SessionStart primer injection, Grep/Glob Moat blocks with
  well-formed escaped deny JSON, and Stop-hook token totals reaching the
  dashboard.

---

## [0.1.24] — 2026-06-06

### Added

- **`syn doctor [path]` — setup and environment health check (issue #9).** New
  read-only CLI subcommand that runs a one-shot checklist and exits. Checks: Node
  version, `jq` availability (bash Stop/Prime hooks silently no-op without it),
  `claude` CLI on PATH, graph freshness (symbol count, schema version, scan age),
  `.mcp.json` project-scope registration (required for Synthra tools to appear in
  the Claude Code IDE), CLAUDE.md policy-block version, and hook installation
  status. Warnings surface with the exact `syn .` command needed to resolve them.
  The command mutates nothing — safe to run at any time.

- **Graph-tool usage metric on the dashboard (issue #2).** The MCP server now
  appends a record to `.synthra-graph/tool_log.jsonl` on every Synthra tool call
  (`graph_continue`, `graph_read`, `graph_register_edit`, etc.). `delta.ts`
  aggregates per-tool call counts into `ProjectStats.tool_calls` (per-project) and
  `global.tool_calls` (cross-project totals). The dashboard shows a new "Graph
  tools used" card in the right column with per-tool counts. This is a positive
  signal complementing the Moat's blocked-Grep count: it captures Synthra pivots
  that happen before a Grep fires, which the block counter misses entirely.

- **Session-aware routing — `graph_continue` seeds retrieval with the session's
  touched files (issue #14).** Files the human recently saved (last 15 min) and
  files the AI registered via `graph_register_edit` now get a ranking boost in
  `graph_continue` results, so the returned context tracks what you're actually
  working on. Mirrors the `/pack` route, which already seeded retrieval this way.

---

## [0.1.23] — 2026-06-06

### Added

- **Dashboard token-log dedupe can now be disabled via `SYN_DASHBOARD_DEDUPE=0`.**
  By default, `delta.ts` deduplicates `token_log.jsonl` entries that share the
  same project, usage totals, and second-rounded timestamp — collapsing the
  duplicate writes that a co-installed AI tool's Stop hook may produce. Set
  `SYN_DASHBOARD_DEDUPE=0` (also accepts `off` or `false`) to see every raw
  entry. Useful when debugging multi-tool coexistence or auditing raw log data.

- **Graph schema-migration check on load.** A new `SCHEMA_VERSION` constant is
  exported from `src/graph/types.ts` and stamped into `info_graph.json` by
  `buildGraph`. On server start, `http.ts` compares the stored graph's
  `schema_version` to the current constant; if they differ it triggers an
  automatic one-time rescan instead of serving an incompatible graph. No
  behavior change today — all graphs are v1 and schema_version matches — but
  this is the forward-safety mechanism for future schema bumps so existing
  graphs are never silently misread.

### Fixed

- **JS/TS parser now captures member-assigned functions** (`exports.handler = fn`,
  `module.exports.route = () => {}`, `this.x = () => {}`). Previously these
  CommonJS/member-export patterns were invisible to the query, so modules that
  exclusively use this style extracted zero symbols and degraded to whole-file
  reads via `graph_read`. A member-assignment capture has been added to both
  `JS_QUERY` and `TS_QUERY` in `src/scanner/parsers/typescript.ts`. Note: a
  pure-wiring `server.js` whose only structure is anonymous inline-callback
  arguments (e.g. `io.use(...)` / `socket.on(event, fn)`) is genuinely
  symbol-less — that is correct, and the gate's symbol-hit guard already
  prevents blocking such files.

### Changed

- **Policy block v4 → v5.** Adds a "large file — pull the symbol, don't
  chunk" nudge to address recurring dogfood friction: on large files Claude
  was reading successive line-range chunks instead of fetching the specific
  symbol via `graph_read("file::symbol")`. The v5 block now explicitly
  instructs: when a file is large, use `graph_read("file/path.ts::SymbolName")`
  to pull the symbol directly rather than reading successive line-range chunks.
  `POLICY_VERSION` bumped `4 → 5`; existing v4 blocks auto-upgrade on the
  next `syn .` run.

---

## [0.1.22] — 2026-06-06

### Fixed

- **`graph_read` now resolves shortened file paths (path-suffix fallback).** Previously
  `graph_read` performed an exact `path === target` match only. Passing a shortened path
  like `appsettings.json` returned "file not found" even when
  `connectwarev2/.../appsettings.json` was indexed. A new `resolveFileTarget` helper (now
  exported) tries an exact match first; on a miss it looks for a unique path-suffix match
  and serves that file; if multiple files share the suffix it reports them as ambiguous with
  candidate paths rather than guessing. Symbol lookups use the resolved path. No API or
  protocol change. Roadmap item #11.

- **Gate content-keyword relaxation now intersects file contents, not just file paths.**
  The Moat's recent-activity relaxation previously matched query tokens against the paths of
  recently-touched files only. A query like `Grep "login"` would not relax on a recent save
  of `auth.ts` unless the word "login" appeared in the path. Now the relaxation also checks
  the recently-touched file's graph-node keywords (its indexed content), so a recent save
  relaxes a Grep whenever the file *contains* the queried term — not just when the path
  matches it. Completes roadmap item #3.

### Changed

- **Dashboard Projects card shows a first-run hint in the empty state.** When no projects
  have run `syn .` yet, the Projects card now displays "No projects yet — run `syn .` in a
  project to start" instead of a blank card. The Recent-turns card already carried this
  hint; Projects now matches it. Roadmap item #10.

- **`bin` path normalization (chore).** Ran `npm pkg fix` to normalize `bin` entries from
  `./bin/syn` to `bin/syn`. Silences the cosmetic publish warnings
  (`"bin[syn]" script name was cleaned`). `syn` and `synthra` still resolve to the same
  entry point. Roadmap item #4.

---

## [0.1.21] — 2026-06-06

### Added

- **HubL (HubSpot CMS) symbol extraction for `.html` and `.hubl` files.**
  Previously `.html` files were content-indexed only — keyword search and
  whole-file reads, no symbol-level granularity. On HubSpot projects this
  meant the graph contributed nothing: zero `graph_continue`/`graph_read`
  calls resolved to symbol slices all session. Now `.html` and `.hubl` files
  run through a new **regex-based** parser (`parsers/hubl.ts`; there is no
  tree-sitter grammar for HubL):
  - `{% macro name(args) %}` → extracted as a `function` symbol
  - `{% block name %}` → extracted as a `component` symbol
  - `{% include / extends / import / from "path" %}` → import edges (relative
    paths resolve to local templates; `.html`/`.hubl` added to the resolver's
    extension list)

  Plain HTML with no HubL tags is unaffected — the parser yields zero symbols
  and zero imports, identical to before. No API, protocol, or policy-block
  change. Roadmap item #12.

---

## [0.1.20] — 2026-06-06

### Fixed

- **Gate (Moat) no longer blocks Grep/Glob queries the graph cannot answer with a symbol.**
  Previously, the PreToolUse gate blocked whenever retrieval confidence was `medium` or `high`,
  but confidence is driven by keyword and path hits too — not only by symbol matches. This meant
  literal/attribute/CSS-selector patterns (`data-tour=`, `class=`, `: 100%`, `.filter-bar`,
  `<div>`) and path-only Globs were blocked and redirected to `graph_read`, which has no symbol
  slice to return for those queries, so Claude fell back to Grep or a whole-file Read anyway —
  a wasted round-trip. Found across multiple dogfood sessions including well-indexed Svelte
  repos. Two new guards close the gap:
  - **Query-shape pre-filter** — Grep patterns that target markup, CSS, attributes, or string
    literals are allowed through up front, before the retrieval step runs.
  - **Symbol-hit requirement** — the gate now only blocks when retrieval matched a symbol whose
    name the query mentions exactly. `RetrievalResult` gained a `symbolMatched` flag; the scorer
    exposes `exactSym`.

  Net effect: genuine symbol lookups still block (verified: `fetchWith429Retry`,
  `MAX_ROWS_PER_TABLE`, `verifyPin`, `SOCKET_AUTH_SECRET`, `seedCredentials`); queries that
  could never have been answered by the graph now allow through without the wasted redirect.
  No API, protocol, or policy-block change — purely server-side gate behavior.

- **Gate and rank test coverage added** (`tests/gate.test.ts`, `tests/rank.test.ts`).
  Chips at the v0.2 backlog item to fill vitest tests beyond `it.todo` placeholders.

---

## [0.1.19] — 2026-06-01

### Changed

- **Policy block v4: targeted Read-before-Edit for graph-discovered files.**
  Claude Code's `Edit` tool requires a file to have been opened with its own
  `Read` tool; a `graph_read` slice does not satisfy that gate. Previously,
  editing a file known only through `graph_read` would fail with *"File has
  not been read yet"* and force a whole-file `Read` — eroding token savings on
  edit-heavy sessions. The v4 policy now instructs: take the line range already
  reported in the `graph_read` header (e.g. `…::handler (L120-168)`), do a
  targeted `Read` with matching `offset`/`limit`, then `Edit`. This satisfies
  the gate while keeping the read small. Existing v3 blocks auto-upgrade on the
  next `syn .` run.

---

## [0.1.18] — 2026-06-01

### Fixed

- **Stop hook on Linux/macOS no longer posts zero tokens to the dashboard.** The bash
  `stop.sh` hook extracted `transcript_path` from the Claude Code Stop payload using a
  greedy `sed` capture (`\(.*\)"`). Because the real payload has additional fields after
  `transcript_path`, the capture grabbed those trailing fields and produced a
  non-existent path string. The `-f` file check therefore always failed, totals were
  never POSTed to `/log`, and the dashboard stayed stuck at 0 on every turn (GitHub
  issue #1). Fixed by parsing with `jq -r '.transcript_path // empty'` and moving the
  `command -v jq` guard above the parse so the hook exits cleanly when `jq` is absent.
- **SessionStart/PreCompact primer hook (`prime.sh`) hardened the same way.** The
  `/prime` response is `{"primer":"…","port":…}`, so the old greedy capture accidentally
  injected trailing `","port":…` junk into the primer string. Because primer text can
  contain inner quotes, a negated-class fix (`[^"]*`) would have truncated it at the
  first quote — `jq -r '.primer // empty'` is the correct parse. Switched `printf '%b'`
  to `printf '%s'` since `jq -r` already decodes JSON escapes.
- Both fixes are **bash-only**. The Windows PowerShell hooks (`stop.ps1`, `prime.ps1`)
  use `ConvertFrom-Json` and were already correct.

---

## [0.1.17] — 2026-05-29

### Added

- **`syn .` scaffolds an agent-onboarding CLAUDE.md on brand-new projects.**
  When a project has no CLAUDE.md, Synthra now writes a lean skeleton —
  `Build & test`, `Conventions`, `Key decisions`, `Gotchas` (with TODO
  prompts) — *above* its managed policy block, instead of a bare policy
  block. This is the durable "why/how" layer the graph can't infer; the
  graph still owns "what/where." Fill it in, or run `/init` to auto-draft.
  The skeleton is written **once** and lives outside the
  `<!-- synthra-policy -->` markers, so re-running `syn .` (which
  refreshes the policy block) never clobbers what you've written.
  Projects that already have a CLAUDE.md are untouched — no skeleton is
  injected.

---

## [0.1.16] — 2026-05-29

### Changed

- **Moat card shows 50 recent gate decisions** (was 12). The inline list
  already scrolls within the card, and the `/data` payload already carries
  up to 500 gates, so this just renders more of them. The headline block
  count was always all-time/uncapped — unchanged.

---

## [0.1.15] — 2026-05-29

### Changed

- **Recent turns are paginated.** The dashboard now carries up to 500 turns
  (was 25) and shows them 25 per page with Prev/Next controls — so you can
  browse history instead of only seeing the last 25. Configurable via
  `SYN_DASHBOARD_RECENT_N` (default 500).
- **Model-usage donut is now all-time, not last-25.** It was tallying models
  from the capped recent-turns window, so a run of >25 same-model turns showed
  that model at 100% and hid the rest. It now sums the uncapped per-project
  model counts, so it always reflects your true all-time split.
- **Dashboard poll slowed 2s → 10s.** Lighter on resources and steadier to
  read; pagination stays live (the current page re-renders each poll).

---

## [0.1.14] — 2026-05-29

### Changed

- **Dashboard visual refresh.** No API surface change — all visual / UX.
  - Removed the hero strip and the standalone Legend card. Date + active
    project now live as compact chips inside the top nav (active-project
    path uses RTL truncation so the folder name stays visible).
  - New **Projects bar chart** in the left column — colored bars ranked
    by turn count. Stable per-name OKLCH palette (8 colors, hash-keyed)
    so a project keeps the same color across sessions. Click any row to
    open its full breakdown.
  - **Donut legend** gains a turn-count column alongside the percentage.
  - **Savings card** elevated: radial green backdrop, money figure 40px,
    soft glow — makes the "what Synthra saved you" number the visual
    anchor of the dashboard.
  - **Recent turns column headers** are now hover-explainable.
  - Active-project chip tightens + month name hides under 1100px width.

---

## [0.1.13] — 2026-05-29

### Fixed

- **Dashboard footer version is now dynamic.** Was hardcoded to `v0.1.8`
  in the HTML and never updated. The dashboard server now injects the
  running binary's version (from `package.json`) into the footer on every
  `GET /` via a `__SYN_VERSION__` placeholder. Re-run `syn .` after an
  update and the dashboard reflects the new version automatically.

---

## [0.1.12] — 2026-05-29

### Fixed

- **`Language.query is deprecated` spam at scan time.** Every parsed file
  printed the warning — 57 prints on a Flutter codebase, one per parsed
  file. Switched all four parsers (TypeScript, JavaScript, Python, Dart,
  plus the generic helper) from the deprecated `language.query(QUERY)`
  to `new Query(language, QUERY)`. No behavior change, just clean
  terminal output.

---

## [0.1.11] — 2026-05-29

### Fixed

- **Dart parser actually runs now.** Was silently broken since v0.1 due to an
  ABI mismatch (shipped wasm was ABI v15, pinned `web-tree-sitter` only
  supported v13–v14). Every `.dart` file got zero symbols, zero imports —
  the exception was swallowed by the parser's try/catch. Bumped
  `web-tree-sitter` to `^0.25.10` to fix.
- **Real Dart symbol extraction.** Classes, mixins, extensions, enums,
  typedefs, top-level functions, methods, getters, setters, constructors.
- **Dart import normalization.** `package:foo/bar.dart` and `dart:async` are
  stripped (cross-project); bare `'sibling.dart'` is rewritten to
  `./sibling.dart` so the project resolver can complete them.

### Changed

- **Update check runs on every `syn .`** (no more 24h cache). If you're on
  latest, stays silent. If outdated, prompts `[y/N]` as before.
- **Auto-update now shows a changelog.** After `npm install -g …@latest`
  succeeds, Synthra prints the new version's section from this file before
  telling you to re-run. Catches `npm install` outside of `syn .` too —
  next startup compares your current version to `~/.synthra/last-seen-version.json`
  and prints if it's newer.

---

## [0.1.10] — 2026-05-29

### Changed

- **CLAUDE.md policy v2 → v3.** Session-end now goes through
  `context_remember({kind: "task"|"decision"|"next"})` instead of writing
  `.synthra/CONTEXT.md` directly. The Stop hook always re-rendered CONTEXT.md
  from `context-store.json` — under v2 Claude's direct writes were getting
  wiped on session end. Existing v2 blocks auto-upgrade.

### Added

- **Scanner ignores more build caches.** `.dart_tool/`, `.flutter-plugins`,
  `.flutter-plugins-dependencies`, `.gradle/`, `target/`, `Pods/`,
  `DerivedData/`, `__pycache__/`, `.venv/`, `venv/`, `.tox/`,
  `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `obj/`, `.vs/`.

---

## [0.1.9] — 2026-05-29

### Fixed

- **Crash on prototype-colliding symbol names.** `buildSymbolIndex` built
  the lookup on a plain `{}`, so a symbol named `toString` (which every
  Dart class overrides), `constructor`, `valueOf`, etc. resolved to the
  inherited `Object.prototype` member and crashed on `.push`. Now uses
  `Object.create(null)` on both fresh-build and load-from-disk paths.

---

## [0.1.8] — 2026-05-29

### Added

- **Interactive auto-update.** `syn .` checks npm at startup; if a newer
  version is available, prompts `[y/N]`. On `y`, runs
  `npm install -g @jefuriiij/synthra@latest` with stdio inherited and
  exits with re-run instructions. Non-TTY runs (CI, piped stdin) fall
  back to a silent one-line hint. `SYN_NO_UPDATE_CHECK=1` opts out.

---

## [0.1.7] — 2026-05-29

### Fixed

- **JS parser missed CommonJS imports + JS class names.** Unified TS/JS
  query only matched ES `import_statement`, and used `(type_identifier)`
  for class names — which is TS-grammar-only. Result: every `.js`/`.cjs`/
  `.mjs` file silently produced zero imports, and any class in a JS file
  was skipped. Split into `TS_QUERY` and `JS_QUERY`; JS query adds a
  `require()` capture and uses `(identifier)` for class names.

---

## [0.1.6] — 2026-05-29

### Fixed

- **MCP registration now uses `--scope project`** so the Claude Code IDE
  extension actually sees Synthra. The previous `--scope local` wrote to
  a per-project section of `~/.claude.json` that only the `claude` CLI
  reads — invisible to the IDE.

---

## [0.1.5] and earlier

See [GitHub commits](https://github.com/jefuriiij/synthra/commits/main) for
detail. v0.1.5 introduced the v2 policy template with namespace + skip rules;
v0.1.4 fixed a DEP0190 deprecation on Windows; v0.1.3 was the dashboard
redesign (Cool Marine palette, FAQ modal, savings audit row).
