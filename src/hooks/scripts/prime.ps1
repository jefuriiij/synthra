# SessionStart + PreCompact hook — Windows PowerShell.
# Reads .synthra-graph/mcp_port, calls GET /prime, prints the primer to stdout
# (Claude Code appends stdout to the session's system prompt). Always exits 0;
# any failure leaves Claude with the prompt it would have gotten without Synthra.

$ErrorActionPreference = "SilentlyContinue"

$portFile = Join-Path $PWD ".synthra-graph\mcp_port"
if (-not (Test-Path $portFile)) { exit 0 }
$port = (Get-Content -Path $portFile -Raw).Trim()
if (-not $port) { exit 0 }

try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/prime" -Method GET -TimeoutSec 3
    if ($resp.primer) { Write-Output $resp.primer }
} catch {
    # silent on failure — Claude continues without the primer
}
exit 0
