# GKG capture daemon - install script (Corazon, run as Tate)
# -----------------------------------------------------------
# 1. Verifies prerequisites (AutoHotkey v2, .env populated, allowlist present).
# 2. Registers a Windows Scheduled Task that auto-starts the daemon at user logon.
# 3. Starts the task immediately for the smoke run.
#
# Run from D:\.code\eos-laptop-agent\daemons (or wherever the repo lands)
# in a regular PowerShell window:
#
#     cd D:\.code\eos-laptop-agent\daemons
#     powershell -ExecutionPolicy Bypass -File .\install-gkg-capture.ps1
#
# Re-running is idempotent.

param(
    [string]$AhkExe = "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe",
    [string]$TaskName = "GKG-Capture-Daemon"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$daemon = Join-Path $here "gkg-capture.ahk"
$envFile = Join-Path $here ".env"
$allowlist = Join-Path $here "gkg-allowlist.json"

Write-Host "[gkg-install] daemon=$daemon"

if (-not (Test-Path $AhkExe)) {
    throw "AutoHotkey v2 not found at $AhkExe. Install from https://www.autohotkey.com/v2 (or pass -AhkExe <path>)."
}
if (-not (Test-Path $daemon))     { throw "missing $daemon" }
if (-not (Test-Path $envFile))    { throw "missing $envFile (copy .env.example -> .env and fill GKG_DAEMON_HMAC_SECRET)" }
if (-not (Test-Path $allowlist))  { throw "missing $allowlist" }

# Ensure session root exists.
$sessionRoot = "D:\.code\macro-recordings\gkg"
if (-not (Test-Path $sessionRoot)) {
    New-Item -ItemType Directory -Path $sessionRoot -Force | Out-Null
}

# Register/replace the scheduled task.
$action = New-ScheduledTaskAction -Execute $AhkExe -Argument "`"$daemon`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Write-Host "[gkg-install] registering Scheduled Task $TaskName"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

Write-Host "[gkg-install] starting task $TaskName"
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "[gkg-install] task state=$state"
Write-Host "[gkg-install] tray icon: AutoHotkey v2 should be visible. Right-click for Pause/Resume."
Write-Host "[gkg-install] log: $here\gkg-capture.log"
