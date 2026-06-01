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

# Parse the primer with jq, not sed. Primer text legitimately contains quotes, so a
# negated-class capture ([^"]*) would truncate it at the first inner quote, while the
# old greedy capture (.*") over-ran into the trailing "port" field and injected junk.
# jq -r also decodes JSON escapes, so we print with %s (not %b). No jq → no primer.
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

PRIMER=$(curl -sS --max-time 3 "http://127.0.0.1:$PORT/prime" 2>/dev/null \
  | jq -r '.primer // empty' 2>/dev/null \
  | head -c 8000)

if [ -n "$PRIMER" ]; then
  printf '%s\n' "$PRIMER"
fi
exit 0
