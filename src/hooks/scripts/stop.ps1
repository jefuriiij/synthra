# Stop hook — Windows PowerShell.
# Reads Claude's transcript JSONL from $hookInput.transcript_path, sums
# usage.* token counts across all assistant turns since the last offset, and
# POSTs the totals to /log. Since v0.20 the same pass also collects Task/Agent
# tool_use events (subagent delegations) so the dashboard can compute the
# Dispatcher follow-rate. Uses a per-transcript .stopoffset file to avoid
# double-counting on session resume. Since v0.33 it ends by asking /nudge
# whether Claude should save what it learned before it stops.

$ErrorActionPreference = "SilentlyContinue"

# Claude Code talks to hooks in UTF-8. PowerShell 5.1 uses the console code
# page instead, which turned every accent and arrow into junk (v0.49).
try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }
try { $hookInput = $raw | ConvertFrom-Json -ErrorAction Stop } catch { exit 0 }

$transcript = $hookInput.transcript_path
if (-not $transcript -or -not (Test-Path -LiteralPath $transcript)) { exit 0 }

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

$offsetFile = "$transcript.stopoffset"
$startOffset = 0
if (Test-Path -LiteralPath $offsetFile) {
    $val = (Get-Content -LiteralPath $offsetFile -Raw).Trim()
    if ($val -match '^\d+$') { $startOffset = [int]$val }
}

$sessionId = [IO.Path]::GetFileNameWithoutExtension($transcript)

$lines = Get-Content -LiteralPath $transcript -Encoding UTF8
$inT = 0; $outT = 0; $cc = 0; $cr = 0; $c1h = 0; $model = ""
$delegations = New-Object System.Collections.ArrayList
$toolCalls = 0
$readCalls = 0
$lineNum = 0
$badLine = 0
foreach ($line in $lines) {
    $lineNum++
    if ($lineNum -le $startOffset) { continue }
    if (-not $line) { continue }
    try { $e = $line | ConvertFrom-Json -ErrorAction Stop } catch { $badLine = $lineNum; continue }

    # Subagent delegations: assistant content blocks calling Task/Agent.
    foreach ($blk in @($e.message.content)) {
        if (-not $blk -or $blk.type -ne "tool_use") { continue }
        $toolCalls++
        if ($blk.name -eq "Read") { $readCalls++ }
        if ($blk.name -ne "Task" -and $blk.name -ne "Agent") { continue }
        $ts = $e.timestamp
        if ($ts -is [DateTime]) { $ts = $ts.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }
        if (-not $ts) { $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }
        [void]$delegations.Add(@{
            ts          = "$ts"
            agent       = $blk.input.subagent_type
            model       = $blk.input.model
            description = $blk.input.description
            session_id  = $sessionId
        })
    }

    $usage = $e.message.usage
    if (-not $usage) { continue }
    $inT  += [int]($usage.input_tokens               | ForEach-Object { if ($_) { $_ } else { 0 } })
    $outT += [int]($usage.output_tokens              | ForEach-Object { if ($_) { $_ } else { 0 } })
    $cc   += [int]($usage.cache_creation_input_tokens | ForEach-Object { if ($_) { $_ } else { 0 } })
    $cr   += [int]($usage.cache_read_input_tokens     | ForEach-Object { if ($_) { $_ } else { 0 } })
    # The part of the cache writes kept for 1 hour, which costs 2x input, not 1.25x (v0.44).
    $c1h  += [int]($usage.cache_creation.ephemeral_1h_input_tokens | ForEach-Object { if ($_) { $_ } else { 0 } })
    if ($e.message.model) { $model = $e.message.model }
}

# A last line that won't parse is usually one Claude Code is still writing:
# leave it for the next Stop instead of skipping it for good (v0.49).
$done = $lineNum
if ($badLine -eq $lineNum -and $lineNum -gt $startOffset) { $done = $lineNum - 1 }

if ($inT -eq 0 -and $outT -eq 0 -and $delegations.Count -eq 0) {
    Set-Content -LiteralPath $offsetFile -Value $done -Encoding ASCII
    exit 0
}

$payloadMap = @{
    input_tokens                = $inT
    output_tokens               = $outT
    cache_creation_input_tokens = $cc
    cache_read_input_tokens     = $cr
    cache_creation_1h_input_tokens = $c1h
    model                       = $model
    description                 = "synthra-stop-hook"
    project                     = $root
    # So the server can count this session's subagent transcripts too (v0.46).
    transcript_path             = $transcript
    read_calls                  = $readCalls
}
if ($delegations.Count -gt 0) { $payloadMap.delegations = $delegations }
$payload = $payloadMap | ConvertTo-Json -Compress -Depth 5

# The offset moves on only when the server took the turns, so usage made while
# Synthra was down is sent the next time instead of being lost (v0.49).
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/log" -Method POST `
        -Body $payload -ContentType "application/json; charset=utf-8" -TimeoutSec 3 | Out-Null
    Set-Content -LiteralPath $offsetFile -Value $done -Encoding ASCII
} catch {
    # silent
}

# Refresh CONTEXT.md from the branch-scoped store.
$ctxPayload = @{ transcript_path = $transcript } | ConvertTo-Json -Compress
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/context-update" -Method POST `
        -Body $ctxPayload -ContentType "application/json; charset=utf-8" -TimeoutSec 3 | Out-Null
} catch {
    # silent
}

# Memory and skill nudges (v0.33): every N replies without a change to
# MEMORY.md/USER.md, or N tool calls without a skill saved, the server answers
# with a reason, and this hook asks Claude Code to keep Claude for one more
# step ({"decision":"block"}). stop_hook_active is passed through so the step
# Claude takes because of a nudge is never nudged again.
$nudgePayload = @{
    stop_hook_active = ($hookInput.stop_hook_active -eq $true)
    tool_calls       = $toolCalls
} | ConvertTo-Json -Compress
try {
    $nudge = Invoke-RestMethod -Uri "http://127.0.0.1:$port/nudge" -Method POST `
        -Body $nudgePayload -ContentType "application/json; charset=utf-8" -TimeoutSec 3
    if ($nudge -and $nudge.reason) {
        [Console]::Out.Write((@{ decision = "block"; reason = [string]$nudge.reason } | ConvertTo-Json -Compress))
    }
} catch {
    # silent
}
exit 0
