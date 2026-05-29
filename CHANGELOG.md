# Synthra changelog

Notable changes per version. This file ships inside the npm tarball — `syn .`
reads it after an auto-update to show you what changed.

For older versions, see [GitHub Releases](https://github.com/jefuriiij/synthra/releases).

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
