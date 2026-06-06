#!/usr/bin/env bash
# PreToolUse hook — bash. POSTs the tool call to /gate; if server returns
# "block", emits the deny-decision JSON to stdout for Claude Code to enforce.
# Always exits 0; server failures leave Claude untouched.
# Requires `jq` to read the gate response; falls back to silent no-op (no
# enforcement) if absent — same policy as the Stop/Prime hooks.

set +e

PORT_FILE="$PWD/.synthra-graph/mcp_port"
if [ ! -f "$PORT_FILE" ]; then exit 0; fi
PORT=$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$PORT" ]; then exit 0; fi

INPUT=$(cat 2>/dev/null)
if [ -z "$INPUT" ]; then exit 0; fi

RESP=$(curl -sS --max-time 3 -X POST -H "Content-Type: application/json" \
  --data "$INPUT" "http://127.0.0.1:$PORT/gate" 2>/dev/null)

# Parse the gate response with jq, not a greedy sed capture. The block `reason`
# legitimately contains double quotes (it quotes the query, e.g. "login"), so the
# old sed capture (\(.*\)") both over-ran into the trailing JSON fields and, once
# embedded raw in the heredoc, produced invalid hook output. jq reads each field
# and re-emits the deny object with correct escaping. (matches stop.sh / prime.sh,
# jq fix #1.) No jq → no enforcement; bail silently like the other hooks.
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

DECISION=$(printf '%s' "$RESP" | jq -r '.decision // empty' 2>/dev/null)
if [ "$DECISION" = "block" ]; then
  REASON=$(printf '%s' "$RESP" | jq -r '.reason // empty' 2>/dev/null)
  jq -nc --arg r "$REASON" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi
exit 0
