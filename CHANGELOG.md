# Synthra changelog

Notable changes per version. This file ships inside the npm tarball — `syn .`
reads it after an auto-update to show you what changed.

For older versions, see [GitHub Releases](https://github.com/jefuriiij/synthra/releases).

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
