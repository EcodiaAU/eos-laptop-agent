# Kill-only helper for the eos-laptop-agent listener on :7456.
# Run ELEVATED when the agent was started elevated (Stop-Process needs matching
# integrity). After this, relaunch the agent UNELEVATED (Start-Process node
# index.js from a normal session) so future restarts self-serve without UAC.
# Robust netstat parse (Get-NetTCPConnection hangs on this box).
$found = netstat -ano | Where-Object { $_ -match ":7456\s" -and $_ -match "LISTENING" }
$pids = $found | ForEach-Object { ($_ -split '\s+' | Where-Object { $_ -ne '' })[-1] } | Sort-Object -Unique
if (-not $pids) { Write-Output "no listener on 7456"; return }
foreach ($p in $pids) {
  try { Stop-Process -Id ([int]$p) -Force -ErrorAction Stop; Write-Output "killed $p" }
  catch { Write-Output "ERROR killing ${p}: $_" }
}
