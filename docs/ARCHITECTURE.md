# Synthra — Architecture

> Living document. Update as the implementation lands.

## Overview

Synthra is a local CLI (`syn`) that sits between you and your AI coding assistant. It builds a semantic graph of your codebase, pre-packs the relevant files into each prompt, and tracks both AI activity and human activity across turns and sessions.

```
            ┌────────────────────────┐
your edits  │   File watcher          │
git ops     │   Git watcher           │──┐
            └────────────────────────┘  │
                                        ▼
┌─────────┐   tree-sitter   ┌────────────────────┐
│ Scanner ├────────────────▶│ Graph (info_graph) │
└─────────┘                 └─────────┬──────────┘
                                      │
                                      ▼
                            ┌────────────────────┐
                            │ Context packer     │
                            └─────────┬──────────┘
                                      │
                                      ▼
                            ┌────────────────────┐
                            │ HTTP MCP server    │  port 8080-8099, one owner
                            │  /prime /pack /log │  per project (mcp_owner.json)
                            │  /gate /route /mcp │
                            │  /activity /health │  ← Claude Code hooks + MCP
                            └─────────┬──────────┘
                                      │
                                      ▼
                                  Claude Code
```

A separate standalone dashboard process (`src/dashboard/`, port 8901, fallback
8901–8910) reads the same on-disk logs and is not part of the request path
above — see [PROTOCOL.md](PROTOCOL.md) for its own route list.

## Component map

See [ROADMAP.md](../ROADMAP.md) for the milestone breakdown.

| Module | Responsibility | Milestone |
|---|---|---|
| `src/cli/` | argument parsing, dispatch, bootstrap, cleanup | M1, M3 |
| `src/scanner/` | walk + parse + extract → graph; content-hash parse cache for incremental rescans | M1 |
| `src/graph/` | types, store, retrieve, rank | M1, M2 |
| `src/packer/` | structured context pack (~4K tokens) | M2 |
| `src/server/` | HTTP MCP server, routes, the gate (moat), project ownership (`owner.ts`) | M2, M3 |
| `src/hooks/` | Claude Code hook installer + scripts (5 events × 2 platforms) | M3 |
| `src/memory/` | session state + cross-session context store | M1, M4 |
| `src/activity/` | file + git watchers (the human-activity wedge) | M5 |
| `src/dashboard/` | localhost token dashboard + Arsenal browser (own server, port 8901) | M6 |
| `src/learn/` | usage-learning: decayed access-log aggregate feeds ranking | v0.2.0+ |
| `src/shared/` | paths, logger, config, atomic JSON store | M1 |

## Storage layout

When `syn .` runs in a project, two folders appear:

- `.synthra-graph/` — gitignored. Heavy machine-local state: graph, session, activity log, token log, MCP port file (`mcp_port`) and its ownership sibling (`mcp_owner.json` — records which process/project owns that port, since ports are machine-global and outlive the process that wrote them).
- `.synthra/` — **git-tracked**. Branch-partitioned team memory: `context-store.json`, `CONTEXT.md`, `branches/<branch>/...`.

## Hook flow

```
SessionStart      → GET  /prime          → primer text into Claude
UserPromptSubmit  → POST /route          → Dispatcher hint (shadow mode by default; SYN_ROUTE_HINTS=1 to inject)
PreToolUse        → POST /gate           → block/allow decision (THE MOAT)
PreCompact        → GET  /prime          → re-prime after auto-compaction
Stop              → POST /log            → token usage from transcript
                  → POST /context-update → update CONTEXT.md
```

## Non-goals (v0.1)

Re-verified 2026-08-09 against current code — the first three still hold; the fourth has partially shipped:

- IDE companion extension — still not built.
- Embedding-based retrieval (keyword + import-graph is enough to start) — still not built.
- Codex/Cursor/Gemini support (fast follow once Claude works) — still not built.
- ~~Diff-tracked incremental updates (M1 does full re-parse)~~ — **partially superseded.** `scanner/hash.ts`'s content-hash cache skips re-parsing unchanged files on rescan (shipped v0.3.0), and the MCP server auto-reindexes on file/git changes without a manual re-scan (v0.9.0). What's still true: the whole graph (including file contents) is held in memory each run — comfortable into the low thousands of files — and there's no lazy on-disk graph for very large (1M-file) monorepos.
