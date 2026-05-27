# Synthra — Protocol Reference

> HTTP routes + MCP tool schemas. Living document — fill in alongside implementation.

## HTTP routes

All routes are served by the local MCP server at `http://127.0.0.1:<port>` where `<port>` is in `8080–8099`, written to `.synthra-graph/mcp_port`.

| Method | Path | Caller | Purpose | Milestone |
|---|---|---|---|---|
| `GET` | `/prime` | SessionStart hook, PreCompact hook | Returns priming text + recent stored context. | M3 |
| `POST` | `/pack` | MCP tools, internal | Returns a context pack for a query. | M2 |
| `POST` | `/log` | Stop hook | Append a token usage entry to `token_log.jsonl`. | M3 |
| `POST` | `/gate` | PreToolUse hook | Decide block/allow for a tool call. | M3 |
| `GET` | `/activity` | MCP tool `recent_activity` | Returns recent human-activity events. | M5 |
| `POST` | `/context-update` | Stop hook | Update `CONTEXT.md` from session transcript. | M4 |

## MCP tools

Exposed over MCP-HTTP. Names follow common conventions for graph-based code-context tools.

| Tool | Args | Returns | Milestone |
|---|---|---|---|
| `graph_continue` | `{ query: string }` | `{ recommended_files, confidence, reason }` | M2 |
| `graph_read` | `{ target: "file::symbol" }` | source snippet | M2 |
| `graph_register_edit` | `{ files: string[] }` | ack | M2 |
| `recent_activity` | `{ since_ms?: number }` | activity events | M5 |
| `count_tokens` | `{ text: string }` | `{ tokens: number }` | M6 |

## Hook payloads

(See `src/hooks/scripts/` for the actual scripts.)

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
