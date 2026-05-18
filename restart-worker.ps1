"$(Get-Date -Format o) START" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
Start-Sleep -Seconds 2
"$(Get-Date -Format o) AFTER_SLEEP" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
# Find listener PID via netstat (Get-NetTCPConnection hangs on this box)
$netstat = & cmd.exe /c "netstat -ano -p TCP" 2>$null
$listenerLine = $netstat | Where-Object { $_ -match "^\s*TCP\s+\S+:7456\s+\S+\s+LISTENING" } | Select-Object -First 1
"$(Get-Date -Format o) NETSTAT_LINE=$listenerLine" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
if ($listenerLine -and ($listenerLine -match "(\d+)\s*$")) {
  $agentPid = [int]$matches[1]
  "$(Get-Date -Format o) AGENT_PID=$agentPid" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
  try {
    Stop-Process -Id $agentPid -Force -ErrorAction Stop
    "$(Get-Date -Format o) KILLED" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
  } catch {
    "$(Get-Date -Format o) ERROR_KILL: $_" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
  }
} else {
  "$(Get-Date -Format o) NO_LISTENER_FOUND" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
}
Start-Sleep -Seconds 1
$env:AGENT_TOKEN = "fad80809116f70923d200b371d4b1b922e38951bac5fc30df516652cfea6011f"
$env:AGENT_PORT = "7456"
try {
  Start-Process node -ArgumentList "D:\.code\eos-laptop-agent\index.js" -WorkingDirectory "D:\.code\eos-laptop-agent" -WindowStyle Hidden
  "$(Get-Date -Format o) STARTED_NEW" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
} catch {
  "$(Get-Date -Format o) ERROR_START: $_" | Out-File -FilePath "D:\.code\eos-laptop-agent\restart-trace.log" -Append -Encoding utf8
}
