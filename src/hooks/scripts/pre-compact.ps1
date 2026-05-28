# PreCompact hook — Windows PowerShell.
# Re-injects the primer after Claude auto-compacts. Same logic as prime.ps1.

$ErrorActionPreference = "SilentlyContinue"

$portFile = Join-Path $PWD ".synthra-graph\mcp_port"
if (-not (Test-Path $portFile)) { exit 0 }
$port = (Get-Content -Path $portFile -Raw).Trim()
if (-not $port) { exit 0 }

try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/prime" -Method GET -TimeoutSec 3
    if ($resp.primer) { Write-Output $resp.primer }
} catch {
    # silent
}
exit 0
