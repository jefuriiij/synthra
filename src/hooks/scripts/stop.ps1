# Stop hook — Windows PowerShell.
# Reads Claude's transcript JSONL from $hookInput.transcript_path, sums
# usage.* token counts across all assistant turns since the last offset, and
# POSTs the totals to /log. Uses a per-transcript .stopoffset file to avoid
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

$lines = Get-Content -Path $transcript
$inT = 0; $outT = 0; $cc = 0; $cr = 0; $model = ""
$lineNum = 0
foreach ($line in $lines) {
    $lineNum++
    if ($lineNum -le $startOffset) { continue }
    if (-not $line) { continue }
    try { $e = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    $usage = $e.message.usage
    if (-not $usage) { continue }
    $inT  += [int]($usage.input_tokens               | ForEach-Object { if ($_) { $_ } else { 0 } })
    $outT += [int]($usage.output_tokens              | ForEach-Object { if ($_) { $_ } else { 0 } })
    $cc   += [int]($usage.cache_creation_input_tokens | ForEach-Object { if ($_) { $_ } else { 0 } })
    $cr   += [int]($usage.cache_read_input_tokens     | ForEach-Object { if ($_) { $_ } else { 0 } })
    if ($e.message.model) { $model = $e.message.model }
}

Set-Content -Path $offsetFile -Value $lineNum -Encoding ASCII

if ($inT -eq 0 -and $outT -eq 0) { exit 0 }

$payload = @{
    input_tokens                = $inT
    output_tokens               = $outT
    cache_creation_input_tokens = $cc
    cache_read_input_tokens     = $cr
    model                       = $model
    description                 = "stop-hook"
    project                     = $PWD.Path
} | ConvertTo-Json -Compress

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
