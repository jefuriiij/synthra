#!/usr/bin/env bash
# SessionStart + PreCompact hook — bash.
# Reads .synthra-graph/mcp_port, calls GET /prime, prints the primer to stdout.
# Always exits 0; any failure leaves Claude with the prompt it would have had
# without Synthra.

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
