#!/usr/bin/env bash
# Stop hook — bash. Reads transcript JSONL, sums usage.* across new lines,
# POSTs totals to /log. Uses a .stopoffset file to avoid double-counting.
# Requires `jq` for robust JSON parsing; falls back to silent no-op if absent.

set +e

INPUT=$(cat 2>/dev/null)
if [ -z "$INPUT" ]; then exit 0; fi

TRANSCRIPT=$(printf '%s' "$INPUT" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi

PORT_FILE="$PWD/.synthra-graph/mcp_port"
if [ ! -f "$PORT_FILE" ]; then exit 0; fi
PORT=$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$PORT" ]; then exit 0; fi

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

OFFSET_FILE="${TRANSCRIPT}.stopoffset"
START_OFFSET=0
if [ -f "$OFFSET_FILE" ]; then
  START_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null | tr -d '[:space:]')
  case "$START_OFFSET" in ''|*[!0-9]*) START_OFFSET=0 ;; esac
fi

TOTAL_LINES=$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d ' ')
TOTAL_LINES=${TOTAL_LINES:-0}

if [ "$TOTAL_LINES" -le "$START_OFFSET" ]; then exit 0; fi

USAGE=$(tail -n +$((START_OFFSET + 1)) "$TRANSCRIPT" 2>/dev/null \
  | jq -s '
      map(select(.message.usage != null) | .message)
      | reduce .[] as $m (
          {in:0, out:0, cc:0, cr:0, model:""};
          .in    += ($m.usage.input_tokens // 0)
          | .out += ($m.usage.output_tokens // 0)
          | .cc  += ($m.usage.cache_creation_input_tokens // 0)
          | .cr  += ($m.usage.cache_read_input_tokens // 0)
          | .model = ($m.model // .model)
        )
    ' 2>/dev/null)

printf '%s' "$TOTAL_LINES" > "$OFFSET_FILE"

IN=$(printf '%s' "$USAGE" | jq -r '.in // 0')
OUT=$(printf '%s' "$USAGE" | jq -r '.out // 0')
CC=$(printf '%s' "$USAGE" | jq -r '.cc // 0')
CR=$(printf '%s' "$USAGE" | jq -r '.cr // 0')
MODEL=$(printf '%s' "$USAGE" | jq -r '.model // ""')

if [ "$IN" = "0" ] && [ "$OUT" = "0" ]; then exit 0; fi

curl -sS --max-time 3 -X POST -H "Content-Type: application/json" \
  --data "$(jq -nc --argjson i "$IN" --argjson o "$OUT" --argjson cc "$CC" --argjson cr "$CR" --arg m "$MODEL" --arg p "$PWD" \
    '{input_tokens:$i, output_tokens:$o, cache_creation_input_tokens:$cc, cache_read_input_tokens:$cr, model:$m, description:"stop-hook", project:$p}')" \
  "http://127.0.0.1:$PORT/log" >/dev/null 2>&1

# Refresh CONTEXT.md from the branch-scoped store.
curl -sS --max-time 3 -X POST -H "Content-Type: application/json" \
  --data "$(jq -nc --arg t "$TRANSCRIPT" '{transcript_path:$t}')" \
  "http://127.0.0.1:$PORT/context-update" >/dev/null 2>&1

exit 0
