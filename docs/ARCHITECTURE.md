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
                            │ HTTP MCP server    │  port 8080-8099
                            │  /prime /pack /log │
                            │  /gate /activity   │  ← Claude Code hooks
                            └─────────┬──────────┘
                                      │
                                      ▼
                                  Claude Code
```

## Component map

See [ROADMAP.md](../ROADMAP.md) for the milestone breakdown.

| Module | Responsibility | Milestone |
|---|---|---|
| `src/cli/` | argument parsing, dispatch, bootstrap, cleanup | M1, M3 |
| `src/scanner/` | walk + parse + extract → graph | M1 |
| `src/graph/` | types, store, retrieve, rank | M1, M2 |
| `src/packer/` | structured context pack (~4K tokens) | M2 |
| `src/server/` | HTTP MCP server, routes | M2, M3 |
| `src/hooks/` | Claude Code hook installer + scripts | M3 |
| `src/memory/` | session state + cross-session context store | M1, M4 |
| `src/activity/` | file + git watchers (the human-activity wedge) | M5 |
| `src/dashboard/` | localhost token dashboard | M6 |
| `src/shared/` | paths, logger, config | M1 |

## Storage layout

When `syn .` runs in a project, two folders appear:

- `.synthra-graph/` — gitignored. Heavy machine-local state: graph, session, activity log, token log, MCP port file.
- `.synthra/` — **git-tracked**. Branch-partitioned team memory: `context-store.json`, `CONTEXT.md`, `branches/<branch>/...`.

## Hook flow

```
SessionStart  → GET  /prime        → primer text into Claude
PreToolUse    → POST /gate         → block/allow decision (THE MOAT)
PreCompact    → GET  /prime        → re-prime after auto-compaction
Stop          → POST /log          → token usage from transcript
              → POST /context-update → update CONTEXT.md
```

## Non-goals (v0.1)

- IDE companion extension (designed for; built post-v0.1)
- Diff-tracked incremental updates (M1 does full re-parse)
- Embedding-based retrieval (keyword + import-graph is enough to start)
- Codex/Cursor/Gemini support (fast follow once Claude works)
