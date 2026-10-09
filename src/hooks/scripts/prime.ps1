# SessionStart + PreCompact hook — Windows PowerShell.
# Reads .synthra-graph/mcp_port, calls GET /prime, prints the primer to stdout
# (Claude Code appends stdout to the session's system prompt). Always exits 0;
# any failure leaves Claude with the prompt it would have gotten without Synthra.

$ErrorActionPreference = "SilentlyContinue"

# Claude Code runs hooks in the session's current folder, which moves when
# Claude cd's into a subfolder. CLAUDE_PROJECT_DIR is the project root.
$root = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { $PWD.Path }
$portFile = Join-Path $root ".synthra-graph\mcp_port"
if (-not (Test-Path $portFile)) { exit 0 }
$port = (Get-Content -Path $portFile -Raw).Trim()
if (-not $port) { exit 0 }
# mcp_port is a plain text file a cloned repo can ship: only a port number may
# reach the URL, or "8081@evil.com" would send this hook's data to evil.com.
if ($port -notmatch '^\d{1,5}$') { exit 0 }
$port = [int]$port
if ($port -lt 1 -or $port -gt 65535) { exit 0 }
if (([Uri]"http://127.0.0.1:$port/").Host -ne '127.0.0.1') { exit 0 }

try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/prime" -Method GET -TimeoutSec 3
    if ($resp.primer) { Write-Output $resp.primer }
} catch {
    # silent on failure — Claude continues without the primer
}
exit 0
