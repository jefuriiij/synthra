# Stop hook — Windows PowerShell.
# Reads Claude's transcript JSONL from $hookInput.transcript_path, sums
# usage.* token counts across all assistant turns since the last offset, and
# POSTs the totals to /log. Since v0.20 the same pass also collects Task/Agent
# tool_use events (subagent delegations) so the dashboard can compute the
# Dispatcher follow-rate. Uses a per-transcript .stopoffset file to avoid
# double-counting on session resume.

$ErrorActionPreference = "SilentlyContinue"

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }
try { $hookInput = $raw | ConvertFrom-Json -ErrorAction Stop } catch { exit 0 }

$transcript = $hookInput.transcript_path
if (-not $transcript -or -not (Test-Path $transcript)) { exit 0 }

$portFile = Join-Path $PWD ".synthra-graph\mcp_port"
if (-not (Test-Path $portFile)) { exit 0 }
$port = (Get-Content -Path $portFile -Raw).Trim()
if (-not $port) { exit 0 }

$offsetFile = "$transcript.stopoffset"
$startOffset = 0
if (Test-Path $offsetFile) {
    $val = (Get-Content -Path $offsetFile -Raw).Trim()
    if ($val -match '^\d+$') { $startOffset = [int]$val }
}

$sessionId = [IO.Path]::GetFileNameWithoutExtension($transcript)

$lines = Get-Content -Path $transcript
$inT = 0; $outT = 0; $cc = 0; $cr = 0; $model = ""
$delegations = New-Object System.Collections.ArrayList
$lineNum = 0
foreach ($line in $lines) {
    $lineNum++
    if ($lineNum -le $startOffset) { continue }
    if (-not $line) { continue }
    try { $e = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }

    # Subagent delegations: assistant content blocks calling Task/Agent.
    foreach ($blk in @($e.message.content)) {
        if (-not $blk -or $blk.type -ne "tool_use") { continue }
        if ($blk.name -ne "Task" -and $blk.name -ne "Agent") { continue }
        $ts = $e.timestamp
        if ($ts -is [DateTime]) { $ts = $ts.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }
        if (-not $ts) { $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }
        [void]$delegations.Add(@{
            ts         = "$ts"
            agent      = $blk.input.subagent_type
            model      = $blk.input.model
            session_id = $sessionId
        })
    }

    $usage = $e.message.usage
    if (-not $usage) { continue }
    $inT  += [int]($usage.input_tokens               | ForEach-Object { if ($_) { $_ } else { 0 } })
    $outT += [int]($usage.output_tokens              | ForEach-Object { if ($_) { $_ } else { 0 } })
    $cc   += [int]($usage.cache_creation_input_tokens | ForEach-Object { if ($_) { $_ } else { 0 } })
    $cr   += [int]($usage.cache_read_input_tokens     | ForEach-Object { if ($_) { $_ } else { 0 } })
    if ($e.message.model) { $model = $e.message.model }
}

Set-Content -Path $offsetFile -Value $lineNum -Encoding ASCII

if ($inT -eq 0 -and $outT -eq 0 -and $delegations.Count -eq 0) { exit 0 }

$payloadMap = @{
    input_tokens                = $inT
    output_tokens               = $outT
    cache_creation_input_tokens = $cc
    cache_read_input_tokens     = $cr
    model                       = $model
    description                 = "synthra-stop-hook"
    project                     = $PWD.Path
}
if ($delegations.Count -gt 0) { $payloadMap.delegations = $delegations }
$payload = $payloadMap | ConvertTo-Json -Compress -Depth 5

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/log" -Method POST `
        -Body $payload -ContentType "application/json" -TimeoutSec 3 | Out-Null
} catch {
    # silent
}

# Refresh CONTEXT.md from the branch-scoped store.
$ctxPayload = @{ transcript_path = $transcript } | ConvertTo-Json -Compress
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/context-update" -Method POST `
        -Body $ctxPayload -ContentType "application/json" -TimeoutSec 3 | Out-Null
} catch {
    # silent
}
exit 0
