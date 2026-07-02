# UserPromptSubmit hook — Windows PowerShell.
# THE DISPATCHER. Reads the prompt event from stdin (JSON), POSTs it to /route,
# and prints the routing hint (if any) to stdout — Claude Code injects
# UserPromptSubmit stdout into the conversation as added context.
# Always exits 0; any failure leaves the prompt untouched.

$ErrorActionPreference = "SilentlyContinue"

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }

try {
    $hookInput = $raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}
if (-not $hookInput.prompt) { exit 0 }

$portFile = Join-Path $PWD ".synthra-graph\mcp_port"
if (-not (Test-Path $portFile)) { exit 0 }
$port = (Get-Content -Path $portFile -Raw).Trim()
if (-not $port) { exit 0 }

$payload = @{ prompt = $hookInput.prompt } | ConvertTo-Json -Compress

try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/route" -Method POST `
        -Body $payload -ContentType "application/json" -TimeoutSec 3
    if ($resp.hint) { Write-Output $resp.hint }
} catch {
    # silent on failure — the prompt proceeds without a routing hint
}
exit 0
