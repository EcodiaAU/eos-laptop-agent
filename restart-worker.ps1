"$(Get-Date -Format o) START" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
Start-Sleep -Seconds 2
"$(Get-Date -Format o) AFTER_SLEEP" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
# Find listener PID(s) on 7456 (Get-NetTCPConnection hangs on this box; the
# old `netstat -ano -p TCP` + `^\s*TCP...LISTENING` parse returned nothing on
# this box - it left the old process alive and double-launched. 2026-05-29 fix:
# plain `netstat -ano`, match any line with :7456 + LISTENING (covers both the
# 0.0.0.0:7456 and [::]:7456 rows), take the trailing token as the PID, kill
# every distinct PID found.)
$listenerLines = netstat -ano | Where-Object { $_ -match ":7456\s" -and $_ -match "LISTENING" }
$pids = $listenerLines | ForEach-Object { ($_ -split '\s+' | Where-Object { $_ -ne '' })[-1] } | Sort-Object -Unique
"$(Get-Date -Format o) LISTENER_PIDS=$($pids -join ',')" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
if ($pids) {
  foreach ($p in $pids) {
    try {
      Stop-Process -Id ([int]$p) -Force -ErrorAction Stop
      "$(Get-Date -Format o) KILLED $p" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
    } catch {
      "$(Get-Date -Format o) ERROR_KILL ${p}: $_" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
    }
  }
} else {
  "$(Get-Date -Format o) NO_LISTENER_FOUND" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
}
Start-Sleep -Seconds 1
$env:AGENT_TOKEN = "fad80809116f70923d200b371d4b1b922e38951bac5fc30df516652cfea6011f"
$env:AGENT_PORT = "7456"
# Autonomy substrate Phase 3: scheduler dispatch loop on laptop-agent.
# See backend/docs/superpowers/specs/2026-05-26-autonomy-substrate-design.md.
$env:SCHEDULER_ENABLED = "true"
$env:DATABASE_URL = "postgresql://postgres.nxmtfzofemtrlezlyhcj:QR2uOIG0IcS8YSvq@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres"
try {
  Start-Process node -ArgumentList "D:\.code\eos-laptop-agent\index.js" -WorkingDirectory "D:\.code\eos-laptop-agent" -WindowStyle Hidden
  "$(Get-Date -Format o) STARTED_NEW" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
} catch {
  "$(Get-Date -Format o) ERROR_START: $_" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
}
