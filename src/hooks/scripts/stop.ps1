# Stop hook — Windows PowerShell.
# Reads Claude's transcript JSONL (from $hookInput.transcript_path), sums
# token usage, POSTs to /log on the MCP server and to the dashboard.
# Uses an offset file to avoid double-counting on session resume.
# TODO: M3

Write-Error "[syn] stop.ps1 not yet implemented (M3)"
