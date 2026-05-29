# Synthra — Implementation Plan

## Context

**Why this exists.** AI coding assistants (Claude Code, Codex, Cursor) burn tokens exploring codebases on every turn — grep, glob, read, repeat. They also lose context between turns and sessions, and they are blind to what the human is doing in their editor between AI turns. The user wants to build **Synthra** (CLI: `syn`) — a local context engine that addresses all three problems.

**Key capabilities:**

1. **Deterministic enforcement via PreToolUse hooks** — block AI Grep/Glob calls when the graph already has the answer, instead of relying on CLAUDE.md prose policy. The hook returns `{"decision":"block","reason":"..."}` and the AI literally cannot disobey.
2. **Branch-aware, git-tracked context store** — `.synthra/` is committed to the repo (default-on), partitioned by branch. Teammates inherit decisions; cross-machine resumption works.
3. **Human-activity awareness** — chokidar file-watcher + `.git/HEAD` + `git status` watcher feeds a recent-activity log. AI sees "user saved auth.ts 12s ago, here's the diff" automatically.
4. **Per-turn cost transparency** — dashboard breaks down every turn into (system prompt / conversation history / Synthra context / your message / response) with a live "savings vs. baseline" delta computed from blocked-Grep counts.
5. **Test ↔ source co-retrieval** — when packing context for `getUser.ts`, automatically include `getUser.test.ts`. Free win.
6. **Fully MIT open-source** — engine and launcher.

**Locked decisions (from conversation):**
- **Name:** Synthra (synthesis + -ra suffix, two-syllable brand-style)
- **CLI:** primary `syn`, alias `synthra`
- **Stack:** TypeScript / Node (chosen over Python for cleaner Windows install, npm distribution, future VS Code extension reuse)
- **First AI target:** Claude Code via HTTP MCP
- **Parsers v0.1:** TS/JS, Python, Svelte, Vue (tree-sitter via WASM)
- **License:** MIT (fully open-source, both engine and launcher)
- **Repo:** new public repo at `github.com/jefuriiij/synthra`, cloned to `C:\Users\Jeff\Desktop\personal-project\synthra` — completely separate from `Optima-Solutions-Dev/Skills` (which is a private org repo for Claude Code skills, not standalone tools)
- **Storage split:** `.synthra-graph/` (gitignored, heavy machine-state) + `.synthra/` (git-tracked, branch-partitioned, shared team memory)
- **Ctrl+C UX:** catches latest session JSONL from `~/.claude/projects/<encoded-cwd>/`, prints `syn --resume <id>`

---

## Implementation order

Six milestones, each independently testable.

### M1 — Skeleton + Scanner (the foundation)

Output: `syn .` scans the current directory, writes `.synthra-graph/info_graph.json` + `symbol_index.json`, updates `.gitignore`, patches `CLAUDE.md` with a versioned policy block, creates `.synthra/` if missing. No AI integration yet.

Build:
- Repo skeleton (package.json, tsconfig, LICENSE, README, .gitignore, bin/syn)
- `src/cli/index.ts` + `src/cli/bootstrap.ts`
- `src/scanner/walker.ts` (respects .gitignore + .synthraignore)
- `src/scanner/parser.ts` + per-language parsers (TS/JS, Python, Svelte, Vue) using tree-sitter WASM
- `src/scanner/extract.ts` — produces graph nodes (files, symbols) + edges (imports, calls)
- `src/scanner/keywords.ts` — rare-word/TF-IDF keyword extraction per file
- `src/graph/store.ts` — writes JSON files with a stable schema (so the dashboard and downstream tools can reuse it)
- `src/hooks/claude-md.ts` — idempotent CLAUDE.md policy block with `<!-- synthra-policy v1 BEGIN/END -->` markers

**Verification:** Run `syn .` in `windsor-stables`. Inspect generated `info_graph.json` — for a 191-file project, expect roughly 1000+ symbols and 1700+ edges. Verify `.gitignore` has `.synthra-graph/` added with comment. Verify `CLAUDE.md` has the policy block. Verify `.synthra/` exists.

### M2 — HTTP MCP server + Context Packer

Output: `syn serve` starts a Hono HTTP server on 8080-8099, exposes MCP tools (`graph_continue`, `graph_read`, `graph_register_edit`), plus the routes hooks need (`/prime`, `/log`, `/pack`, `/gate`). Test via curl, not Claude yet.

Build:
- `src/server/http.ts` (Hono, free-port discovery 8080-8099)
- `src/server/mcp.ts` (MCP-over-HTTP protocol handler)
- `src/server/routes/prime.ts`, `pack.ts`, `log.ts`, `gate.ts`, `activity.ts`
- `src/server/port.ts` (writes `.synthra-graph/mcp_port`)
- `src/graph/retrieve.ts` (query → ranked file list)
- `src/graph/rank.ts` (keyword + import-distance + recency)
- `src/packer/index.ts` + `signatures.ts` + `inline.ts` + `format.ts` (~4K-token structured pack)
- `src/packer/tests.ts` (test ↔ source co-retrieval) ← improvement #5

**Verification:** Manual `curl http://127.0.0.1:8080/pack -d '{"query":"login"}'`. Inspect returned pack — should be structured (signatures + top function bodies), under 4K tokens, and include matching test files alongside source files.

### M3 — Claude Code integration (the moat)

Output: `syn .` registers Synthra's MCP with Claude Code via `claude mcp add`, installs the four hooks (SessionStart, PreToolUse, PreCompact, Stop) into `.claude/settings.local.json` + `.claude/hooks/`, and launches `claude`. Pre-injection works. PreToolUse blocking works.

Build:
- `src/hooks/installer.ts` — writes scripts + edits `.claude/settings.local.json` to register hooks
- `src/hooks/scripts/prime.{ps1,sh}` — `GET /prime` → stdout primer
- `src/hooks/scripts/pre-tool-use.{ps1,sh}` — `POST /gate` with the tool call payload → if response is `block`, exit 2 with reason (Claude treats this as deny)
- `src/hooks/scripts/pre-compact.{ps1,sh}` — `GET /prime` (re-inject after auto-compact)
- `src/hooks/scripts/stop.{ps1,sh}` — parse transcript JSONL, sum usage, `POST /log`
- `src/cli/start-claude.ts` — registers MCP + spawns `claude`
- `src/server/routes/gate.ts` — the moat logic: consult graph, decide block/allow

**Verification:** Run `syn .` in `windsor-stables`. Inside Claude, ask "where do we handle expired auth tokens?" Confirm:
1. Context primer appears at session start ("Context loaded (port 8080)")
2. Claude does NOT call Grep (gate blocks it; reason is shown)
3. Claude reads `file::symbol` notation via `graph_read`
4. Token usage logged to `token_log.jsonl` on Stop
5. Ctrl+C produces `syn --resume <id>` line, MCP server shuts down cleanly

### M4 — Branch-aware Context Store

Output: `.synthra/` is git-tracked by default. Decisions made on a feature branch are scoped to that branch and merge naturally. `CONTEXT.md` updates at session end (via Stop hook).

Build:
- `src/memory/context-store.ts` — reads/writes `.synthra/context-store.json` or `.synthra/branches/<branch>/context-store.json`
- `src/memory/branches.ts` — detects current branch, routes reads/writes to correct file
- `src/memory/context-md.ts` — Stop hook generates/updates CONTEXT.md
- Update `src/hooks/scripts/stop.{ps1,sh}` to also POST to a new `/context-update` route

**Verification:** Switch to a feature branch, log a decision via Claude. Verify it lands in `.synthra/branches/<branch>/context-store.json`, not the root. Switch back to main, confirm the feature-branch decision is NOT visible. Merge the branch, confirm the decision merges.

### M5 — Human-activity watcher (the wedge)

Output: File saves outside Claude, branch switches, and uncommitted diffs are visible to the AI via a `/activity` MCP tool. The `gate` route also factors recent activity into block decisions ("user just edited auth.ts → don't block grep on auth files").

Build:
- `src/activity/file-watcher.ts` — chokidar on project root, respects `.gitignore`
- `src/activity/git-watcher.ts` — watches `.git/HEAD` (branch switches), polls `git status --porcelain` every 2s
- `src/activity/activity-log.ts` — rolling 100-event JSONL in `.synthra-graph/activity.jsonl`
- `src/server/routes/activity.ts` — `GET /activity?since=<ts>` returns events
- Update `src/packer/index.ts` — boost recently-touched files in ranking
- Update `src/server/routes/gate.ts` — relax blocking when topic matches recent activity

**Verification:** Run `syn .`. Outside Claude, edit `auth.ts` and save. Inside Claude, ask a question about login. Confirm: (a) the recent edit shows up in the context pack, (b) the response shows awareness of the unsaved change, (c) `activity.jsonl` has the save event.

### M6 — Token dashboard

Output: `http://localhost:8901` shows live per-turn breakdown, total session cost, and savings vs. no-optimizer. Standalone process so it survives MCP restarts.

Build:
- `src/dashboard/server.ts` — independent Hono server, listens on 8901, reads `token_log.jsonl`
- `src/dashboard/delta.ts` — computes estimated "no-optimizer cost" from blocked-Grep counts × avg-tokens-per-Grep
- `src/dashboard/public/index.html` + `app.js` + `style.css` — single-page UI, polls `/data` every 2s
- `src/cli/dashboard-command.ts` — `syn dashboard` opens browser

**Verification:** Run `syn .` for a few turns. Open `http://localhost:8901`. Confirm each turn appears with breakdown (system / conversation / pack / message / response) and total session cost matches summed `token_log.jsonl`. Confirm "saved" delta is non-zero.

---

## Repo layout (in the new `synthra` repo at `C:\Users\Jeff\Desktop\personal-project\synthra`)

```
synthra/
├── README.md
├── LICENSE                            # MIT
├── package.json                       # bin: { "syn": "./bin/syn", "synthra": "./bin/syn" }
├── tsconfig.json
├── .gitignore                         # node_modules, dist, .DS_Store
├── tsup.config.ts                     # or esbuild config
├── ROADMAP.md                         # copy of this plan, scoped for the project
│
├── bin/
│   └── syn                            # #!/usr/bin/env node → ../dist/cli/index.js
│
├── src/
│   ├── cli/
│   │   ├── index.ts                   # arg parsing (commander or sade)
│   │   ├── bootstrap.ts               # .synthra-graph/, .synthra/, .gitignore, CLAUDE.md
│   │   ├── start-claude.ts            # mcp add + spawn claude + trap SIGINT
│   │   ├── cleanup.ts                 # graceful shutdown + resume command print
│   │   ├── session-discovery.ts       # locate latest ~/.claude/projects/<enc>/*.jsonl
│   │   ├── dashboard-command.ts
│   │   └── self-update.ts             # version check on every run
│   │
│   ├── scanner/
│   │   ├── walker.ts                  # ignore .gitignore + .synthraignore
│   │   ├── parser.ts                  # dispatch by file ext
│   │   ├── parsers/{typescript,python,svelte,vue}.ts
│   │   ├── extract.ts                 # files, symbols, imports → graph
│   │   ├── keywords.ts                # rare-word extraction
│   │   └── hash.ts                    # file_hash for incremental update (M1: full re-parse OK)
│   │
│   ├── graph/
│   │   ├── types.ts                   # Node, Edge, Symbol, GraphSchema
│   │   ├── store.ts                   # info_graph.json + symbol_index.json
│   │   ├── retrieve.ts                # query → ranked file list
│   │   └── rank.ts                    # keyword + imports + recency + activity boost
│   │
│   ├── packer/
│   │   ├── index.ts                   # ~4K-token structured pack
│   │   ├── signatures.ts
│   │   ├── inline.ts                  # top function bodies
│   │   ├── tests.ts                   # co-retrieve *.test.* (improvement #5)
│   │   └── format.ts
│   │
│   ├── memory/
│   │   ├── session.ts                 # this-session: AI read/edit log
│   │   ├── context-store.ts           # structured decisions
│   │   ├── context-md.ts              # CONTEXT.md handler
│   │   └── branches.ts                # branch-aware routing (improvement #2)
│   │
│   ├── activity/
│   │   ├── file-watcher.ts            # chokidar (improvement #3)
│   │   ├── git-watcher.ts             # .git/HEAD + status
│   │   └── activity-log.ts            # rolling JSONL
│   │
│   ├── server/
│   │   ├── http.ts                    # Hono
│   │   ├── mcp.ts                     # MCP-over-HTTP
│   │   ├── port.ts                    # 8080–8099 discovery
│   │   └── routes/
│   │       ├── prime.ts               # GET — SessionStart hook
│   │       ├── pack.ts                # POST — context packer
│   │       ├── log.ts                 # POST — token usage
│   │       ├── gate.ts                # POST — PreToolUse decision (THE MOAT)
│   │       ├── activity.ts            # GET — recent human edits
│   │       └── context-update.ts      # POST — Stop hook updates CONTEXT.md
│   │
│   ├── hooks/
│   │   ├── installer.ts               # writes scripts + claude mcp add
│   │   ├── claude-md.ts               # versioned policy block in CLAUDE.md
│   │   └── scripts/
│   │       ├── prime.{ps1,sh}
│   │       ├── pre-tool-use.{ps1,sh}  # THE MOAT (improvement #1)
│   │       ├── pre-compact.{ps1,sh}
│   │       └── stop.{ps1,sh}
│   │
│   ├── dashboard/
│   │   ├── server.ts                  # standalone on 8901
│   │   ├── delta.ts                   # savings vs no-optimizer (improvement #4)
│   │   └── public/{index.html,app.js,style.css}
│   │
│   └── shared/
│       ├── paths.ts                   # resolves .synthra/ vs .synthra-graph/
│       ├── logger.ts
│       └── config.ts                  # env vars (SYN_*)
│
├── tests/
│   ├── scanner.test.ts
│   ├── packer.test.ts
│   ├── rank.test.ts
│   └── fixtures/sample-project/
│
└── docs/
    ├── ARCHITECTURE.md
    └── PROTOCOL.md                    # HTTP routes + MCP tool schemas
```

## What Synthra creates in user projects (e.g., `windsor-stables/`)

```
your-project/
├── .gitignore                         # auto-amended:
│                                      #   # added by optimizer
│                                      #   .synthra-graph/
│
├── CLAUDE.md                          # auto-amended with markers:
│                                      #   <!-- synthra-policy v1 BEGIN -->
│                                      #     ... policy text ...
│                                      #   <!-- synthra-policy v1 END -->
│
├── .claude/
│   ├── settings.local.json            # hooks registered here
│   └── hooks/                         # scripts regenerated each `syn .`
│
├── .synthra-graph/                  # GITIGNORED (machine-local)
│   ├── info_graph.json
│   ├── symbol_index.json
│   ├── session.json
│   ├── activity.jsonl
│   ├── token_log.jsonl
│   ├── mcp_port
│   ├── mcp_server.log
│   └── mcp_server.err.log
│
└── .synthra/                        # GIT-TRACKED (team's memory)
    ├── context-store.json             # default-branch decisions
    ├── CONTEXT.md                     # default-branch narrative
    └── branches/
        └── <branch>/{context-store.json, CONTEXT.md}
```

---

## Tooling choices (proposed; can override at execution)

| Decision | Proposed | Why |
|---|---|---|
| Package manager | **npm** | Ubiquitous; no extra install step for users |
| Build | **tsup** (esbuild under the hood) | Single binary output, watches in dev, fast |
| HTTP framework | **Hono** | Lightweight, fast, works on Node + edge; cleaner than Express |
| AST parsing | **`web-tree-sitter`** (WASM) | Multi-language from one runtime; works on Windows without native build |
| File watching | **chokidar** | Battle-tested, handles Windows quirks |
| CLI args | **sade** or **commander** | Sade is lighter; commander has more docs |
| Tests | **vitest** | Fast, ESM-native, great DX |
| Distribution | **npm package** (`synthra`) | `npm install -g synthra` is the install story |

---

## First execution steps (when plan is approved)

**A. Create and clone the new repo (NOT inside `Optima-Workspace/Skills/`):**

1. Create new public GitHub repo: `gh repo create jefuriiij/synthra --public --license=mit --description="Local context engine for AI coding assistants — graph-based context, branch-aware memory, real-time human-activity awareness"`
2. Clone to `C:\Users\Jeff\Desktop\personal-project\synthra` (alongside other projects, outside the Skills repo).
3. From this point, the working directory is `C:\Users\Jeff\Desktop\personal-project\synthra`. All scaffolding happens there.

**B. Scaffold M1 inside the new repo:**

4. Create `package.json` (name: `synthra`, bin: `{ "syn": "./bin/syn", "synthra": "./bin/syn" }`).
5. Create `tsconfig.json`, `LICENSE` (MIT), `README.md` (with the product positioning), `.gitignore` (node_modules, dist, etc.).
6. Create `bin/syn` (shebang Node script → `dist/cli/index.js`).
7. Stub every `src/**/*.ts` file from the tree with TODO comments + minimal type signatures (no real logic — navigable skeleton only).
8. Run `npm install` for core dependencies (Hono, chokidar, web-tree-sitter, sade, vitest, tsup).
9. Copy this plan to `C:\Users\Jeff\Desktop\personal-project\synthra\ROADMAP.md` so it lives with the project.
10. Initial commit + push to `origin/main`.

**C. Clean up the Skills repo:**

11. Delete the entire `Optima-Workspace/Skills/optimizer/` folder (including `sample-only-delete-later/`). It was always a scratch space — the real work now lives in the new repo.
12. Commit the deletion in the Skills repo with a message like "remove optimizer/ scratch folder — work moved to jefuriiij/synthra".

**D. Stop and report.** Don't proceed to M1 implementation logic without user check-in. The skeleton + first commit is the first concrete artifact and worth reviewing before flesh.

---

## Verification (end-to-end, after M3)

The acceptance test for "Synthra works": run `syn .` in a real repo (`windsor-stables`), open Claude, ask a question that on plain Claude would trigger 3+ Grep/Read tool calls. Expect:

- ✅ Context primer appears at session start
- ✅ Claude answers without calling Grep (PreToolUse gate blocked it; reason printed)
- ✅ Response quality is equal or better than plain Claude
- ✅ Token usage logged; dashboard shows savings vs. estimated plain-Claude cost
- ✅ Ctrl+C prints `syn --resume <session-id>` and shuts down cleanly
- ✅ `syn --resume <id>` restores both Claude's conversation AND Synthra's session memory
- ✅ A decision logged mid-session lands in `.synthra/context-store.json` (or branch dir)
- ✅ Saving a file outside Claude appears in the next turn's context pack

---

## Out of scope for v0.1 (deferred)

- IDE companion extension (VS Code / Antigravity / Cursor) — designed for, not built yet
- Diff-tracked incremental graph updates + lazy on-disk graph (v0.1 does a full re-parse each run and holds the whole graph, file contents included, in memory — tested fine to a few hundred files at sub-second scans, comfortable into the low thousands; very large monorepos need this)
- Embedding-based semantic retrieval (keyword scoring is enough to start)
- Codex CLI / Cursor / Gemini support (same MCP, different launcher — fast follow-on)
- Self-update mechanism (manually `npm i -g synthra@latest` for now)
- macOS/Linux platform parity for hooks (write `.sh` versions in M3, but Windows is primary)
