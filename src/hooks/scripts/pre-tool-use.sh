#!/usr/bin/env bash
# PreToolUse hook — bash. POSTs the tool call to /gate; if server returns
# "block", emits the deny-decision JSON to stdout for Claude Code to enforce.
# Always exits 0; server failures leave Claude untouched.

set +e

PORT_FILE="$PWD/.synthra-graph/mcp_port"
if [ ! -f "$PORT_FILE" ]; then exit 0; fi
PORT=$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$PORT" ]; then exit 0; fi

INPUT=$(cat 2>/dev/null)
if [ -z "$INPUT" ]; then exit 0; fi

RESP=$(curl -sS --max-time 3 -X POST -H "Content-Type: application/json" \
  --data "$INPUT" "http://127.0.0.1:$PORT/gate" 2>/dev/null)

case "$RESP" in
  *'"decision":"block"'*)
    REASON=$(printf '%s' "$RESP" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${REASON}"}}
EOF
    ;;
esac
exit 0
