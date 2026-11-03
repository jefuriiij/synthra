# UserPromptSubmit hook — Windows PowerShell.
# THE DISPATCHER. Reads the prompt event from stdin (JSON), POSTs it to /route,
# and prints the routing hint (if any) to stdout — Claude Code injects
# UserPromptSubmit stdout into the conversation as added context.
# Always exits 0; any failure leaves the prompt untouched.

$ErrorActionPreference = "SilentlyContinue"

# Claude Code talks to hooks in UTF-8. PowerShell 5.1 uses the console code
# page instead, which turned every accent and arrow into junk (v0.49).
try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }

try {
    $hookInput = $raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}
if (-not $hookInput.prompt) { exit 0 }

# Claude Code runs hooks in the session's current folder, which moves when
# Claude cd's into a subfolder. CLAUDE_PROJECT_DIR is the project root.
# Not $PWD for the fallback: PowerShell 5.1 can't enter a folder with [ or ] in
# its name and leaves $PWD at its own folder (v0.49).
$root = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { [IO.Directory]::GetCurrentDirectory() }
$portFile = Join-Path $root ".synthra-graph\mcp_port"
if (-not (Test-Path -LiteralPath $portFile)) { exit 0 }
$port = (Get-Content -LiteralPath $portFile -Raw).Trim()
if (-not $port) { exit 0 }
# mcp_port is a plain text file a cloned repo can ship: only a port number may
# reach the URL, or "8081@evil.com" would send this hook's data to evil.com.
if ($port -notmatch '^\d{1,5}$') { exit 0 }
$port = [int]$port
if ($port -lt 1 -or $port -gt 65535) { exit 0 }
if (([Uri]"http://127.0.0.1:$port/").Host -ne '127.0.0.1') { exit 0 }

$payload = @{ prompt = $hookInput.prompt } | ConvertTo-Json -Compress

try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/route" -Method POST `
        -Body $payload -ContentType "application/json; charset=utf-8" -TimeoutSec 3
    if ($resp.hint) { Write-Output $resp.hint }
} catch {
    # silent on failure — the prompt proceeds without a routing hint
}
exit 0
