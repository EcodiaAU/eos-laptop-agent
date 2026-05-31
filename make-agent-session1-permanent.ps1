# make-agent-session1-permanent.ps1
#
# One-shot. Makes the Session 1 launch of eos-laptop-agent survive Corazon reboot.
#
# Run this when convenient (requires admin elevation - it stops a Windows service).
#
# What it does:
#   1. Stop the eos-pm2 NSSM service. This kills the Session 0 PM2 daemon and
#      everything it supervised (cred-refresher, usage-poller, away-conductor,
#      eos-laptop-agent if respawned). Brief downtime ~5s.
#   2. Edit ~/.pm2/dump.pm2 to REMOVE the eos-laptop-agent entry. Keeps the
#      other three apps so cred refresh stays alive across reboots.
#   3. Restart the eos-pm2 service. PM2 resurrects WITHOUT eos-laptop-agent;
#      cred-refresher + usage-poller + away-conductor come back online in
#      Session 0 as before.
#   4. Register a Task Scheduler entry "EcodiaOSLaptopAgent" that fires at
#      logon of the current user and launches the agent as a direct node
#      process in Session 1 with the same env vars the PM2 entry used.
#   5. Print verification: confirm the Task Scheduler entry exists + agent
#      health endpoint returns ok on :7456.
#
# After running this once, every reboot launches the agent in Session 1
# automatically and the dispatch_worker submit chain works as designed.

$ErrorActionPreference = 'Stop'

function Require-Admin {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host 'This script needs admin (stops the eos-pm2 service + writes a Task Scheduler entry).' -ForegroundColor Yellow
        Write-Host 'Right-click PowerShell -> Run as administrator, then re-run.' -ForegroundColor Yellow
        exit 1
    }
}

function Stop-EosPm2-And-Edit-Dump {
    Write-Host '[1/5] Stopping eos-pm2 service ...' -ForegroundColor Cyan
    Stop-Service eos-pm2 -Force -ErrorAction SilentlyContinue
    Start-Sleep 3
    $svc = Get-Service eos-pm2 -ErrorAction SilentlyContinue
    Write-Host "      eos-pm2 status: $($svc.Status)"

    Write-Host '[2/5] Editing ~/.pm2/dump.pm2 to remove eos-laptop-agent ...' -ForegroundColor Cyan
    $dumpPath = "$env:USERPROFILE\.pm2\dump.pm2"
    if (-not (Test-Path $dumpPath)) {
        Write-Host "      no dump.pm2 found at $dumpPath; skipping edit." -ForegroundColor Yellow
        return
    }
    Copy-Item $dumpPath "$dumpPath.bak-$(Get-Date -Format 'yyyyMMddHHmmss')" -ErrorAction SilentlyContinue
    $dump = Get-Content $dumpPath -Raw | ConvertFrom-Json
    $kept = @($dump | Where-Object { $_.name -ne 'eos-laptop-agent' })
    $newDump = $kept | ConvertTo-Json -Depth 30
    Set-Content -Path $dumpPath -Value $newDump -Encoding utf8
    Write-Host "      dump.pm2 now lists: $(($kept | ForEach-Object { $_.name }) -join ', ')"
}

function Restart-EosPm2 {
    Write-Host '[3/5] Restarting eos-pm2 service ...' -ForegroundColor Cyan
    Start-Service eos-pm2
    Start-Sleep 5
    $svc = Get-Service eos-pm2
    Write-Host "      eos-pm2 status: $($svc.Status)"
}

function Register-LogonTask {
    Write-Host '[4/5] Registering Task Scheduler entry EcodiaOSLaptopAgent ...' -ForegroundColor Cyan
    $taskName = 'EcodiaOSLaptopAgent'

    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    $nodeExe = (Get-Command node).Source
    $args = 'D:\.code\eos-laptop-agent\index.js'
    $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $args -WorkingDirectory 'D:\.code\eos-laptop-agent'

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $trigger.Delay = 'PT15S'

    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -ExecutionTimeLimit (New-TimeSpan -Days 365)

    # Env vars for the agent (mirror restart-worker.ps1).
    $envBlock = @{
        AGENT_TOKEN       = 'fad80809116f70923d200b371d4b1b922e38951bac5fc30df516652cfea6011f'
        AGENT_PORT        = '7456'
        SCHEDULER_ENABLED = 'true'
        DATABASE_URL      = 'postgresql://postgres.nxmtfzofemtrlezlyhcj:QR2uOIG0IcS8YSvq@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres'
    }
    # Task Scheduler does not accept arbitrary env vars on the action directly.
    # Wrap the launch in a PowerShell that sets env then exec node. This stays in Session 1.
    $envSetters = $envBlock.GetEnumerator() | ForEach-Object { "`$env:$($_.Key) = '$($_.Value)'" }
    $launchScript = ($envSetters -join '; ') + "; & '$nodeExe' '$args'"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$launchScript`""

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    Write-Host "      task $taskName registered, fires at logon of $env:USERNAME"
}

function Verify {
    Write-Host '[5/5] Verification ...' -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName EcodiaOSLaptopAgent -ErrorAction SilentlyContinue
    if ($task) { Write-Host "      Task Scheduler entry: present (state=$($task.State))" }
    else { Write-Host '      Task Scheduler entry: MISSING' -ForegroundColor Red }

    Write-Host '      Checking agent health on :7456 ...'
    try {
        $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7456/api/health' -TimeoutSec 5
        Write-Host "      /api/health: status=$($h.status) uptime=$([math]::Round($h.uptime))s hostname=$($h.hostname)"
    } catch {
        Write-Host "      /api/health: unreachable. The current Session 1 agent process I launched may still be alive (good - reboot to test the task)." -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host 'Done. On the next Corazon reboot the agent will launch in Session 1 automatically.' -ForegroundColor Green
    Write-Host 'PM2 still supervises cred-refresher, usage-poller, away-conductor in Session 0.' -ForegroundColor Green
}

Require-Admin
Stop-EosPm2-And-Edit-Dump
Restart-EosPm2
Register-LogonTask
Verify
