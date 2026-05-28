#!/usr/bin/env bash
# PreCompact hook — bash. Re-injects the primer after Claude auto-compacts.

set +e

PORT_FILE="$PWD/.synthra-graph/mcp_port"
if [ ! -f "$PORT_FILE" ]; then exit 0; fi
PORT=$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$PORT" ]; then exit 0; fi

PRIMER=$(curl -sS --max-time 3 "http://127.0.0.1:$PORT/prime" 2>/dev/null \
  | sed -n 's/.*"primer"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' \
  | head -c 8000)

if [ -n "$PRIMER" ]; then
  printf '%b\n' "$PRIMER"
fi
exit 0
