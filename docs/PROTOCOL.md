# Synthra — Protocol Reference

> HTTP routes + MCP tool schemas. Living document — fill in alongside implementation.

## Host requirement (applies to every route on both servers)

Since v0.27, both servers reject any request whose `Host` header does not name
localhost on the port that server is actually bound to — `127.0.0.1:<port>`,
`localhost:<port>` or `[::1]:<port>` — or a hostname listed in `SYN_ALLOWED_HOSTS`
(comma-separated; a bare `dev.box` matches any port, `dev.box:8901` pins one).
A refused request gets `403` with a body naming the variable. A missing `Host`
fails closed.

This exists because binding to `127.0.0.1` does not stop a page in the user's
browser from being used to reach these servers (DNS rebinding). `Host` is the
header to key on: browsers forbid page script from setting it, so a rebound
request always names the attacker's domain. `Origin` cannot substitute — a
rebound request is same-origin, so no `Origin` is sent at all.

## HTTP routes — MCP server (port 8080–8099)

Served by the local MCP server at `http://127.0.0.1:<port>` where `<port>` is in `8080–8099`, written to `.synthra-graph/mcp_port`. This is a *separate* process/port from the dashboard (see below) — one MCP server owns one project (`mcp_owner.json`; see ARCHITECTURE.md).

| Method | Path | Caller | Purpose |
|---|---|---|---|
| `GET` | `/` | diagnostics | Service info: name, version, port, file/symbol counts, graph generation time. |
| `GET` | `/health` | `checkOwner` in `src/server/owner.ts` (v0.26) | Liveness **and identity**: `{ ok, project_root, pid, port }`. A port answering is not proof it's *this* project's server — callers compare `project_root` before trusting it, because ports are machine-global and a stale `mcp_port` file can now name a port a *different* project's Synthra serves. |
| `GET` | `/prime` | SessionStart hook, PreCompact hook | Returns priming text + recent stored context, including the "Since you were last here" resume digest. |
| `POST` | `/pack` | MCP tools, internal | Returns a context pack for a query. |
| `POST` | `/log` | Stop hook | Append a token usage entry to `token_log.jsonl`. |
| `POST` | `/gate` | PreToolUse hook | Decide block/allow for a `Grep`/`Glob` call (THE MOAT). `Bash` calls are also POSTed here but only observed (logged, never blocked). |
| `POST` | `/route` | UserPromptSubmit hook (the Dispatcher, v0.16.0+) | Scores the prompt against the installed Arsenal; returns `{ hint }`. `hint` is `""` unless `SYN_ROUTE_HINTS=1` — injection has been off by default since v0.21's "shadow mode" (a field window measured a 1.2% follow-rate on injected hints). |
| `GET` | `/activity` | MCP tool `recent_activity` | Returns recent human-activity events. |
| `POST` | `/context-update` | Stop hook | Update `CONTEXT.md` from session transcript. |
| `POST` | `/mcp` | Claude Code (MCP client) | JSON-RPC 2.0 envelope — `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`. See MCP tools below. |

10 routes total (verified against `src/server/http.ts`, 2026-08-09).

## HTTP routes — dashboard server (port 8901, fallback 8901–8910)

A second, independent Hono process (`src/dashboard/server.ts`) — outside the MCP port range above, and with no ownership concept (it isn't a single-owner resource).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | The dashboard SPA — Svelte, built by Vite, inlined into one self-contained HTML. |
| `GET` | `/favicon.svg` | Dashboard favicon. |
| `GET` | `/health` | `{ ok: true }` — simple liveness only. |
| `GET` | `/arsenal` | Installed skills/agents/MCP servers (project · personal · plugin scopes) for the Arsenal browser. |
| `GET` | `/arsenal/item` | Full source/frontmatter for one Arsenal item, resolved server-side from `kind`+`scope`+`name` query params (never a raw filesystem path) — backs the detail modal. |
| `GET` | `/favorites` | Machine-wide favorited skills/agents (`~/.synthra/favorites.json`). |
| `POST` | `/favorites` | Set (not toggle) a favorite — the dashboard's only mutating route. |
| `GET` | `/report` | Runs `syn doctor`'s checks server-side; returns them plus a copy-pasteable redacted markdown diagnostic. |
| `GET` | `/data` | Polled every 2s — the full token/gate/tool/route/delegation aggregate the UI renders. |

9 routes total (verified against `src/dashboard/server.ts`, 2026-08-09).

## MCP tools

Exposed over MCP-HTTP (`POST /mcp`, JSON-RPC 2.0). 13 tools total (verified against the `TOOLS` array in `src/server/mcp.ts`, 2026-08-09):

| Tool | Args | Returns |
|---|---|---|
| `graph_continue` | `{ query: string }` | `Confidence` / `Files` / `Reason` header, then signatures + top function bodies + linked tests for the top matches. Session-aware: seeded with recently-edited + `graph_register_edit`-registered paths. |
| `graph_read` | `{ target: "file" \| "file::symbol" }` | Source for a file, or a symbol's body plus a dependency footer (Depends on / Used by), a test-coverage footer, and a targeted `Read(offset,limit)` edit hint. |
| `graph_register_edit` | `{ files: string[] }` | Ack — records the AI's edits so subsequent retrieval ranks them higher. |
| `context_remember` | `{ text: string, kind: "decision"\|"task"\|"next"\|"fact"\|"blocker", tags?: string[], files?: string[] }` | Persists an entry to the branch-aware context store; re-renders `CONTEXT.md`. Linked `files` become staleness anchors. |
| `context_recall` | `{ kind?, branch?, limit? }` | Reads stored context entries, flagging any whose anchored files have since changed. |
| `recent_activity` | `{ since_ms?: number, limit?: number }` | Recent human-activity events (saves, branch switches, diffs). |
| `count_tokens` | `{ text: string }` | `{ tokens: number }` — char/4 estimate. |
| `blast_radius` | `{ target: string, depth?: number }` | A bare-file `target` returns all files that transitively depend on it; a `file::symbol` target returns the exact caller *symbols* (name → file:line) — the rename-safety view. |
| `dead_code` | `{ limit?: number }` | File-level unreferenced-file candidates (entry points excluded heuristically). |
| `find_symbol` | `{ name: string }` | Existing symbols by name — reuse-first check before writing a new one; falls back to near-name matches. |
| `duplicate_symbols` | `{ limit?: number }` | Symbol names (functions/classes/types; methods excluded) defined in ≥2 files — consolidation candidates. |
| `call_path` | `{ from: string, to: string, depth?: number }` | Shortest call chain between two symbols through the `calls` graph. |
| `route_task` | `{ task: string }` | Which installed subagent/skill fits a task, and on which model — the Dispatcher's on-demand form; shares its scorer with `POST /route`. |

Plus the MCP envelope methods: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`.

## Hook payloads

(See `src/hooks/scripts/` for the actual scripts — five hook events (`SessionStart`, `PreToolUse`, `PreCompact`, `Stop`, `UserPromptSubmit`) × two platforms (`.ps1`/`.sh`) = ten scripts.)

### PreToolUse → POST `/gate`

Input (from Claude Code stdin):
```json
{ "tool_name": "Grep", "tool_input": { "pattern": "..." } }
```

Response:
```json
{ "decision": "block" | "allow", "reason": "..." }
```

If `block`, the hook script exits 2 with the reason on stderr; Claude treats exit 2 as a denial.

### Stop → POST `/log`

The hook reads `$hookInput.transcript_path`, parses recent assistant turns out of the JSONL, sums `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`, and POSTs:

```json
{
  "input_tokens": 23,
  "output_tokens": 4870,
  "cache_creation_input_tokens": 53177,
  "cache_read_input_tokens": 454496,
  "model": "claude-sonnet-4-6",
  "description": "auto",
  "project": "C:\\Users\\Jeff\\..."
}
```

Uses an offset file (`<transcript>.stopoffset`) to avoid double-counting on resume.

### UserPromptSubmit → POST `/route` (the Dispatcher, v0.16.0+)

Input:
```json
{ "prompt": "..." }
```

Response:
```json
{ "hint": "..." }
```

`hint` is `""` unless `SYN_ROUTE_HINTS=1` (injection is off by default since v0.21's shadow mode). Harness pseudo-prompts (`<ide_opened_file>`, task notifications, etc.) are detected and skipped without scoring or logging — they made up the majority of hints in the first field window. When non-empty, the hook prints `hint` to stdout, which Claude Code injects as added context.
