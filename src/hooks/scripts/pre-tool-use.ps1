# PreToolUse hook — Windows PowerShell.
# THE MOAT (improvement #1). Reads the tool call from stdin (JSON), POSTs it
# to /gate, and if the server says "block" emits a JSON deny-decision to
# stdout. Claude Code reads stdout JSON to enforce the decision.
# Always exits 0; failure-to-reach-server leaves Claude untouched.

$ErrorActionPreference = "SilentlyContinue"

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }

try {
    $hookInput = $raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}

$portFile = Join-Path $PWD ".synthra-graph\mcp_port"
if (-not (Test-Path $portFile)) { exit 0 }
$port = (Get-Content -Path $portFile -Raw).Trim()
if (-not $port) { exit 0 }

$payload = @{
    tool_name  = $hookInput.tool_name
    tool_input = $hookInput.tool_input
} | ConvertTo-Json -Depth 10 -Compress

try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/gate" -Method POST `
        -Body $payload -ContentType "application/json" -TimeoutSec 3
} catch {
    exit 0
}

if ($resp.decision -eq "block") {
    $denyJson = @{
        hookSpecificOutput = @{
            hookEventName            = "PreToolUse"
            permissionDecision       = "deny"
            permissionDecisionReason = $resp.reason
        }
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Output $denyJson
}
exit 0
