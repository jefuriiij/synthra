#!/usr/bin/env bash
# UserPromptSubmit hook — bash.
# THE DISPATCHER. Reads the prompt event from stdin (JSON), POSTs it to /route,
# and prints the routing hint (if any) to stdout — Claude Code injects
# UserPromptSubmit stdout into the conversation as added context.
# Always exits 0; requires `jq` (silently no-ops without it, like the other hooks).

set +e

# Claude Code runs hooks in the session's current folder, which moves when
# Claude cd's into a subfolder. CLAUDE_PROJECT_DIR is the project root.
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
PORT_FILE="$ROOT/.synthra-graph/mcp_port"
if [ ! -f "$PORT_FILE" ]; then exit 0; fi
PORT=$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$PORT" ]; then exit 0; fi
# mcp_port is a plain text file a cloned repo can ship: only a port number may
# reach the URL, or "8081@evil.com" would send this hook's data to evil.com.
case "$PORT" in *[!0-9]*) exit 0 ;; esac
if [ "${#PORT}" -gt 5 ] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then exit 0; fi

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

INPUT=$(cat 2>/dev/null)
if [ -z "$INPUT" ]; then exit 0; fi

# Re-emit only the prompt field as the request body (jq handles escaping).
BODY=$(printf '%s' "$INPUT" | jq -c '{prompt: (.prompt // empty)}' 2>/dev/null)
if [ -z "$BODY" ] || [ "$BODY" = "{}" ]; then exit 0; fi

HINT=$(curl -sS --max-time 3 -X POST -H "Content-Type: application/json" \
  --data "$BODY" "http://127.0.0.1:$PORT/route" 2>/dev/null \
  | jq -r '.hint // empty' 2>/dev/null \
  | head -c 2000)

if [ -n "$HINT" ]; then
  printf '%s\n' "$HINT"
fi
exit 0
