# reflex-watchdog.ps1
#
# Probes the Corazon reflex substrate and restarts whatever is down.
# Designed to run from Windows Task Scheduler every 5 minutes:
#
#   schtasks /create /sc MINUTE /mo 5 /tn "ecodia-reflex-watchdog" `
#     /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\.code\eos-laptop-agent\scripts\reflex-watchdog.ps1" `
#     /ru "$env:USERNAME" /rl LIMITED /f
#
# What it checks:
#   1. eos-laptop-agent process up + /api/health responds
#   2. VS Code main process up + at least one Claude Code lock file present
#   3. reflex.* tools are registered (POST /api/tool {tool:'reflex.list_mouths'})
#
# Side effects:
#   - Writes a single JSON status line to %USERPROFILE%\.ecodiaos\reflex-watchdog.log
#   - If agent is down: pm2 restart eos-laptop-agent
#   - If VS Code is down with no Claude Code lock file: launches Code with last workspace
#     (only when launched-as-user; Task Scheduler must run "Run only when user is logged on")
#   - Does NOT auto-restart if a check passes; idempotent silent OK.

$ErrorActionPreference = "Stop"
$tokenPath = "$env:USERPROFILE\.ecodiaos\laptop-agent.token"
$logPath = "$env:USERPROFILE\.ecodiaos\reflex-watchdog.log"
$timestamp = (Get-Date).ToString("o")
$result = @{
  ts = $timestamp
  agent_health = $null
  agent_restarted = $false
  reflex_tools_present = $null
  vs_code_running = $null
  lock_file_count = $null
  vs_code_restarted = $false
  errors = @()
}

function Log-Line($obj) {
  $line = $obj | ConvertTo-Json -Compress
  Add-Content -Path $logPath -Value $line -Encoding ascii
}

# 1. Agent health
try {
  $h = Invoke-RestMethod -Uri http://127.0.0.1:7456/api/health -TimeoutSec 4 -ErrorAction Stop
  $result.agent_health = if ($h.status -eq "ok") { "ok" } else { "unexpected_response" }
} catch {
  $result.agent_health = "down"
  $result.errors += "agent_health: $($_.Exception.Message)"
  try {
    pm2 restart eos-laptop-agent --update-env *> $null
    Start-Sleep -Seconds 3
    $h2 = Invoke-RestMethod -Uri http://127.0.0.1:7456/api/health -TimeoutSec 4 -ErrorAction Stop
    if ($h2.status -eq "ok") {
      $result.agent_restarted = $true
      $result.agent_health = "restarted_ok"
    } else {
      $result.agent_health = "restart_failed_unexpected_response"
    }
  } catch {
    $result.agent_health = "restart_failed"
    $result.errors += "pm2_restart: $($_.Exception.Message)"
  }
}

# 2. Reflex tools registered (only if agent is healthy)
if ($result.agent_health -like "*ok*" -or $result.agent_health -eq "restarted_ok") {
  try {
    $token = (Get-Content $tokenPath -Raw).Trim()
    $body = '{"tool":"reflex.list_mouths","params":{}}'
    $r = Invoke-RestMethod -Uri http://127.0.0.1:7456/api/tool -Method Post `
      -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
      -Body $body -TimeoutSec 5 -ErrorAction Stop
    $result.reflex_tools_present = $r.ok -and ($r.result.lock_dir -like "*\.claude\ide*")
    $result.lock_file_count = $r.result.count
  } catch {
    $result.reflex_tools_present = $false
    $result.errors += "reflex_list_mouths: $($_.Exception.Message)"
  }
}

# 3. VS Code running
$codeProcs = Get-Process | Where-Object { $_.ProcessName -eq "Code" -and -not [string]::IsNullOrEmpty($_.MainWindowTitle) }
$result.vs_code_running = ($codeProcs.Count -gt 0)
if (-not $result.vs_code_running -and $result.lock_file_count -eq 0) {
  # VS Code is truly down (no window AND no lock file).
  # Try to relaunch. Only works if running interactively.
  try {
    $codeExe = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
    if (Test-Path $codeExe) {
      Start-Process -FilePath $codeExe -ArgumentList "D:\.code\ecodiaos" -WindowStyle Normal
      $result.vs_code_restarted = $true
    } else {
      $result.errors += "vs_code_exe_not_found: $codeExe"
    }
  } catch {
    $result.errors += "vs_code_relaunch: $($_.Exception.Message)"
  }
}

Log-Line $result

# Trim log to last 1000 lines to keep size bounded.
if (Test-Path $logPath) {
  $lines = Get-Content $logPath -Tail 1000
  Set-Content -Path $logPath -Value $lines -Encoding ascii
}
