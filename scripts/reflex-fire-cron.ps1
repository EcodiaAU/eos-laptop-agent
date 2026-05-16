# reflex-fire-cron.ps1
#
# Wrapper that fires a Corazon reflex from Windows Task Scheduler.
# This is HOW the substrate replaces cloud-Routine cron schedules:
# the OS scheduler invokes this script with a prompt template name, the
# script reads the corresponding .txt prompt body and POSTs it to the
# eos-laptop-agent's reflex.fire (or reflex.fire_if_clear) endpoint.
#
# Usage:
#   .\reflex-fire-cron.ps1 -PromptName "meta-loop" [-AutoSubmit] [-FireIfClear] [-Source "cron-meta-loop"]
#
# Example schtasks registration (hourly meta-loop, fire only if not in non-editor flow):
#
#   schtasks /create /sc HOURLY /tn "ecodia-cron-meta-loop" `
#     /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\.code\eos-laptop-agent\scripts\reflex-fire-cron.ps1 -PromptName meta-loop -AutoSubmit -FireIfClear" `
#     /ru "$env:USERNAME" /rl LIMITED /f
#
# Prompt templates live at: D:\.code\eos-laptop-agent\prompts\<name>.txt
# (kept out of git history of public repos; safe to check into eos-laptop-agent if
# nothing sensitive is templated.)

param(
  [Parameter(Mandatory=$true)][string]$PromptName,
  [string]$Source = "",
  [string]$Editor = "vscode",
  [switch]$AutoSubmit,
  [switch]$FireIfClear,
  [string]$IdempotencyKey = ""
)

$ErrorActionPreference = "Stop"

$tokenPath = "$env:USERPROFILE\.ecodiaos\laptop-agent.token"
$promptPath = "D:\.code\eos-laptop-agent\prompts\$PromptName.txt"
$logPath = "$env:USERPROFILE\.ecodiaos\reflex-fire-cron.log"

if (-not (Test-Path $promptPath)) {
  $err = @{ ts = (Get-Date).ToString("o"); error = "prompt_not_found"; prompt = $PromptName; expected_path = $promptPath } | ConvertTo-Json -Compress
  Add-Content -Path $logPath -Value $err -Encoding ascii
  exit 2
}
if (-not (Test-Path $tokenPath)) {
  $err = @{ ts = (Get-Date).ToString("o"); error = "token_not_found"; expected_path = $tokenPath } | ConvertTo-Json -Compress
  Add-Content -Path $logPath -Value $err -Encoding ascii
  exit 3
}

$prompt = Get-Content -Path $promptPath -Raw
$token = (Get-Content -Path $tokenPath -Raw).Trim()

if ([string]::IsNullOrEmpty($Source)) { $Source = "cron-$PromptName" }
if ([string]::IsNullOrEmpty($IdempotencyKey)) { $IdempotencyKey = "$PromptName-" + (Get-Date -Format "yyyyMMdd-HHmm") }

$toolName = if ($FireIfClear) { "reflex.fire_if_clear" } else { "reflex.fire" }
$body = @{
  tool = $toolName
  params = @{
    prompt = $prompt
    source = $Source
    idempotency_key = $IdempotencyKey
    editor = $Editor
    auto_submit = [bool]$AutoSubmit
  }
} | ConvertTo-Json -Compress -Depth 5

try {
  $resp = Invoke-RestMethod -Uri http://127.0.0.1:7456/api/tool -Method Post `
    -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
    -Body $body -TimeoutSec 25 -ErrorAction Stop
  $line = @{
    ts = (Get-Date).ToString("o")
    prompt_name = $PromptName
    tool = $toolName
    source = $Source
    idempotency_key = $IdempotencyKey
    response = $resp
  } | ConvertTo-Json -Compress -Depth 5
  Add-Content -Path $logPath -Value $line -Encoding ascii
  if (-not $resp.ok) { exit 4 }
  exit 0
} catch {
  $err = @{
    ts = (Get-Date).ToString("o")
    prompt_name = $PromptName
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress
  Add-Content -Path $logPath -Value $err -Encoding ascii
  exit 5
}
