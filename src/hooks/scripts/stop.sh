#!/usr/bin/env bash
# Stop hook — bash. Reads transcript JSONL, sums usage.* across new lines,
# POSTs totals to /log. Since v0.20 the same window is also scanned for
# Task/Agent tool_use events (subagent delegations) feeding the dashboard's
# Dispatcher follow-rate. Uses a .stopoffset file to avoid double-counting.
# Requires `jq` for robust JSON parsing; falls back to silent no-op if absent.

set +e

INPUT=$(cat 2>/dev/null)
if [ -z "$INPUT" ]; then exit 0; fi

# jq is required for the parsing below — bail early (silent no-op) if it's absent.
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

# Extract transcript_path with jq, not sed. A greedy sed capture (\(.*\)") grabs the
# trailing JSON fields after transcript_path and yields a path that doesn't exist, so
# the -f check below always failed and totals were never POSTed to /log. (issue #1)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi

PORT_FILE="$PWD/.synthra-graph/mcp_port"
if [ ! -f "$PORT_FILE" ]; then exit 0; fi
PORT=$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$PORT" ]; then exit 0; fi

OFFSET_FILE="${TRANSCRIPT}.stopoffset"
START_OFFSET=0
if [ -f "$OFFSET_FILE" ]; then
  START_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null | tr -d '[:space:]')
  case "$START_OFFSET" in ''|*[!0-9]*) START_OFFSET=0 ;; esac
fi

TOTAL_LINES=$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d ' ')
TOTAL_LINES=${TOTAL_LINES:-0}

if [ "$TOTAL_LINES" -le "$START_OFFSET" ]; then exit 0; fi

SESSION_ID=$(basename "$TRANSCRIPT" .jsonl)

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

# Subagent delegations in the same window: Task/Agent tool_use content blocks.
DELEG=$(tail -n +$((START_OFFSET + 1)) "$TRANSCRIPT" 2>/dev/null \
  | jq -c --arg s "$SESSION_ID" '
      . as $e
      | ($e.message.content // [])
      | if type == "array" then .[] else empty end
      | select(.type == "tool_use" and (.name == "Task" or .name == "Agent"))
      | { ts: ($e.timestamp // ""),
          agent: (.input.subagent_type // null),
          model: (.input.model // null),
          session_id: $s }
    ' 2>/dev/null | jq -s '.' 2>/dev/null)
DELEG=${DELEG:-[]}
DELEG_N=$(printf '%s' "$DELEG" | jq 'length' 2>/dev/null)
DELEG_N=${DELEG_N:-0}

printf '%s' "$TOTAL_LINES" > "$OFFSET_FILE"

IN=$(printf '%s' "$USAGE" | jq -r '.in // 0')
OUT=$(printf '%s' "$USAGE" | jq -r '.out // 0')
CC=$(printf '%s' "$USAGE" | jq -r '.cc // 0')
CR=$(printf '%s' "$USAGE" | jq -r '.cr // 0')
MODEL=$(printf '%s' "$USAGE" | jq -r '.model // ""')

if [ "$IN" = "0" ] && [ "$OUT" = "0" ] && [ "$DELEG_N" = "0" ]; then exit 0; fi

curl -sS --max-time 3 -X POST -H "Content-Type: application/json" \
  --data "$(jq -nc --argjson i "$IN" --argjson o "$OUT" --argjson cc "$CC" --argjson cr "$CR" --arg m "$MODEL" --arg p "$PWD" --argjson d "$DELEG" \
    '{input_tokens:$i, output_tokens:$o, cache_creation_input_tokens:$cc, cache_read_input_tokens:$cr, model:$m, description:"synthra-stop-hook", project:$p}
     + (if ($d | length) > 0 then {delegations:$d} else {} end)')" \
  "http://127.0.0.1:$PORT/log" >/dev/null 2>&1

# Refresh CONTEXT.md from the branch-scoped store.
curl -sS --max-time 3 -X POST -H "Content-Type: application/json" \
  --data "$(jq -nc --arg t "$TRANSCRIPT" '{transcript_path:$t}')" \
  "http://127.0.0.1:$PORT/context-update" >/dev/null 2>&1

exit 0
