#!/usr/bin/env bash
# PreCompact hook — bash. Re-injects the primer after Claude auto-compacts.

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

# Parse the primer with jq, not sed. The primer now carries a multi-line "Since you
# were last here" resume digest with quotes and newlines, so the old greedy sed capture
# (.*") both over-ran into the trailing "port" field and broke on inner quotes. jq -r
# also decodes JSON escapes, so we print with %s (not %b). No jq → no primer (matches
# prime.sh / stop.sh — completes the jq migration across all bash hooks).
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

PRIMER=$(curl -sS --max-time 3 "http://127.0.0.1:$PORT/prime" 2>/dev/null \
  | jq -r '.primer // empty' 2>/dev/null \
  | head -c 8000)

if [ -n "$PRIMER" ]; then
  printf '%s\n' "$PRIMER"
fi
exit 0
