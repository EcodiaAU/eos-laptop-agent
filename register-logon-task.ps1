# register-logon-task.ps1
# Just the Task Scheduler step that the earlier Python finisher could not land
# (the generated XML had unescaped `&` from the PowerShell call operator).
# Register-ScheduledTask handles escaping for us. Run from the same admin shell.

$ErrorActionPreference = 'Stop'
$taskName = 'EcodiaOSLaptopAgent'

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$envSetters = @(
  "`$env:AGENT_TOKEN='fad80809116f70923d200b371d4b1b922e38951bac5fc30df516652cfea6011f'",
  "`$env:AGENT_PORT='7456'",
  "`$env:SCHEDULER_ENABLED='true'",
  "`$env:DATABASE_URL='postgresql://postgres.nxmtfzofemtrlezlyhcj:QR2uOIG0IcS8YSvq@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres'"
) -join '; '
$nodePath = (Get-Command node).Source
$launch = "$envSetters; Start-Process -FilePath '$nodePath' -ArgumentList 'D:\.code\eos-laptop-agent\index.js' -WorkingDirectory 'D:\.code\eos-laptop-agent' -WindowStyle Hidden"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$launch`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT15S'

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
Write-Host "Registered $taskName (state=$($task.State), triggers at logon of $env:USERNAME)"
Write-Host "To smoke-test without rebooting: Start-ScheduledTask -TaskName $taskName"
