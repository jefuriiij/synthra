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
| `GET` | `/doctor` | IDE extension health light (v0.32) | `syn doctor`'s checks, live: `{ version, status, checks[] }`, `status` = worst of `ok`/`warn`/`fail`. `version` is this server process's — not necessarily what's installed. `?env=1` adds the checks that spawn processes (Node, jq, `claude --version`). The `MCP server` check here compares `mcp_port` to this server's own port instead of probing itself: missing or different = `fail`, since the hooks are then talking to someone else. |
| `GET` | `/prime` | SessionStart hook, PreCompact hook | Returns priming text + recent stored context, including the "Since you were last here" resume digest and (v0.33) the two knowledge files, `.synthra/MEMORY.md` and `~/.synthra/USER.md`. |
| `POST` | `/pack` | MCP tools, internal | Returns a context pack for a query. |
| `POST` | `/log` | Stop hook | Append a token usage entry to `token_log.jsonl`. |
| `POST` | `/nudge` | Stop hook (v0.33) | `{ stop_hook_active?, tool_calls? }` → `{ reason? }`. Every `SYN_MEMORY_NUDGE_EVERY` replies (default 10) without a change to either knowledge file, `reason` asks Claude to save what it learned; every `SYN_SKILL_NUDGE_EVERY` tool calls (default 15) without a skill saved, it asks whether the work was worth a skill; both at once become one question. The hook passes it on as `{"decision":"block","reason":…}`. A reply made because of a Stop hook neither counts nor is nudged. |
| `POST` | `/gate` | PreToolUse hook | Decide block/allow for a `Grep`/`Glob` call (THE MOAT). `Bash` calls are also POSTed here but only observed (logged, never blocked). |
| `POST` | `/route` | UserPromptSubmit hook (the Dispatcher, v0.16.0+) | Scores the prompt against the installed Arsenal; returns `{ hint }`. `hint` is `""` unless `SYN_ROUTE_HINTS=1` — injection has been off by default since v0.21's "shadow mode" (a field window measured a 1.2% follow-rate on injected hints). |
| `GET` | `/activity` | MCP tool `recent_activity` | Returns recent human-activity events. |
| `POST` | `/skills/approve` | IDE extension Learning tab (v0.33) | `{ id }` applies a skill proposal — refused when the file changed since it was proposed. `{ ok, error? }`. |
| `POST` | `/skills/reject` | IDE extension Learning tab (v0.33) | `{ id }` drops a proposal and records the rejection. `{ ok, error? }`. |
| `GET` | `/skills/blob` | IDE extension diffs (v0.33) | `?sha=<40 hex>` → `{ found, text? }`: a skill's before/after text, kept by content hash in `~/.synthra/skills/blobs/`. |
| `POST` | `/skills/pin` | IDE extension Curator (v0.33) | `{ path, on }` pins (or unpins) a skill Synthra wrote, so the Curator never touches it. Refused for any other path. |
| `POST` | `/skills/restore` | IDE extension Curator (v0.33) | `{ archivePath }` moves an archived skill back where it was — refused when something took its place. |
| `POST` | `/curator/run` | IDE extension "Run now" (v0.33) | Runs the Curator now, ignoring the weekly clock and the on/off setting. `{ ok, run }`. |
| `GET` | `/settings` | IDE extension Settings tab (v0.33) | `{ path, settings[] }`: every user-facing setting in `~/.synthra/settings.json` with its `value`, `default`, range and `source` (`default` / `file` / `env` — an environment variable wins and locks the control). |
| `POST` | `/settings` | IDE extension Settings tab (v0.33) | `{ key, value }` sets one setting (`value: null` = back to the default); answers `{ ok, error?, path, settings[] }`. Changing a memory limit rewrites the AGENTS.md block at once. |
| `GET` | `/panels` | IDE extension sidebar and large panel (v0.33) | `{ version, project_root, memory, capabilities, agents }` in one read: the knowledge files and this branch's context entries (with stale files), the arsenal with each item's absolute file, and the last 7 days of delegations, plus the same `settings` as `GET /settings`, and `learning` (proposals with their before/after text and a `stale` flag, the last 30 days of skill changes, the skills Synthra wrote). Each section fails on its own. `?fresh=1` drops the arsenal's 15s memo. |
| `POST` | `/context-update` | Stop hook | Update `CONTEXT.md` from session transcript. |
| `POST` | `/mcp` | Claude Code (MCP client) | JSON-RPC 2.0 envelope — `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`. See MCP tools below. |

21 routes total (verified against `src/server/http.ts`, 2026-10-02).

## HTTP routes — dashboard server (port 8901, fallback 8901–8910)

A second, independent Hono process (`src/dashboard/server.ts`) — outside the MCP port range above, and with no ownership concept (it isn't a single-owner resource).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | The dashboard SPA — Svelte, built by Vite, inlined into one self-contained HTML. |
| `GET` | `/favicon.svg` | Dashboard favicon. |
| `GET` | `/health` | `{ ok: true }` — simple liveness only. |
| `GET` | `/report` | Runs `syn doctor`'s checks server-side; returns them plus a copy-pasteable redacted markdown diagnostic. |
| `GET` | `/data` | Polled every 10s: the token/gate/tool aggregate per project and overall, plus the recent replies the UI renders. |

9 routes total (verified against `src/dashboard/server.ts`, 2026-08-09).

## MCP tools

Exposed over MCP-HTTP (`POST /mcp`, JSON-RPC 2.0). 15 tools total (verified against the `TOOLS` array in `src/server/mcp.ts`, 2026-10-02):

| Tool | Args | Returns |
|---|---|---|
| `graph_continue` | `{ query: string }` | `Confidence` / `Files` / `Reason` header, then signatures + top function bodies + linked tests for the top matches. Session-aware: seeded with recently-edited + `graph_register_edit`-registered paths. |
| `graph_read` | `{ target: "file" \| "file::symbol" }` | Source for a file, or a symbol's body plus a dependency footer (Depends on / Used by), a test-coverage footer, and a targeted `Read(offset,limit)` edit hint. |
| `graph_register_edit` | `{ files: string[] }` | Ack — records the AI's edits so subsequent retrieval ranks them higher. |
| `context_remember` | `{ text: string, kind: "decision"\|"task"\|"next"\|"fact"\|"blocker", tags?: string[], files?: string[] }` | Persists an entry to the branch-aware context store; re-renders `CONTEXT.md`. Linked `files` become staleness anchors. |
| `context_recall` | `{ kind?, branch?, limit? }` | Reads stored context entries, flagging any whose anchored files have since changed. |
| `memory` | `{ target: "project"\|"user", action?: "read"\|"add"\|"replace"\|"remove", content?, old_text?, operations?: [{ action, content?, old_text? }] }` | Reads or changes `.synthra/MEMORY.md` (`project`) or `~/.synthra/USER.md` (`user`). `old_text` finds the entry by a unique piece; `operations` apply together, checked against the final size. Refuses growth past the limit (`SYN_MEMORY_CHARS` 3500 / `SYN_USER_CHARS` 2000) and entries that look like secrets, and answers with the file's current entries either way. |
| `skill_manage` | `{ action: "list"\|"view"\|"create"\|"patch"\|"edit", scope?: "project"\|"global", name?, description?, body?, old_string?, new_string?, reason? }` | Skills in `.claude/skills/` (project) or `~/.claude/skills/` (global), marked `metadata: synthra: learned`. Only marked skills change, and only after a `view` in this server. With `SYN_SKILL_APPROVAL` on (default) create/patch/edit park a proposal in `~/.synthra/skills/pending/`; otherwise they apply at once. Every applied change is a line in `~/.synthra/skills/ledger.jsonl`. |
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

The PreToolUse hook matches `Grep|Glob|Bash|Skill` (v0.33): a `Skill` call is observe-only — `/gate` always allows it and counts the use for the Curator when it is a skill Synthra wrote.

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

After `/log` and `/context-update`, the hook POSTs `{ "stop_hook_active": <bool>, "tool_calls": <n> }` to `/nudge` (v0.33) — `tool_calls` counts the `tool_use` blocks since the last Stop, for the skill nudge. When the answer has a `reason`, the hook prints `{"decision":"block","reason":"…"}` and exits 0 — Claude Code then keeps Claude for one more step and hands it the reason.

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
