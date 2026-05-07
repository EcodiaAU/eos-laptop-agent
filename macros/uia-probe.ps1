param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$EventIndex,
  [Parameter(Mandatory=$true)][string]$SessionId
)

# UIA Probe v1 - Worker B2 deliverable for macro recorder v2
# Captures stable selectors at click time for replay-by-identity (vs replay-by-pixel-coords).
# Invoked fire-and-forget by macro-recorder.ahk (Worker B1).
# Output: appends one JSON line to D:\.code\macro-recordings\<session_id>\uia-enrichments.jsonl
# Performance target: <100ms FromPoint (pwsh startup ~500ms cold dominates; v2.1 = named-pipe daemon).

$ErrorActionPreference = "Stop"

try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  Add-Type -AssemblyName WindowsBase -ErrorAction Stop
} catch {
  # Fallback: write a minimal error record so caller knows we tried
  $outDir = "D:\.code\macro-recordings\$SessionId"
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  $errRec = @{
    event_index = $EventIndex
    uia_query_at = (Get-Date).ToUniversalTime().ToString("o")
    uia_query_duration_ms = 0
    target_uia_selector = $null
    uia_query_status = "error"
    uia_query_error = "UIAutomation assemblies not loadable: $($_.Exception.Message)"
  }
  $errLine = $errRec | ConvertTo-Json -Compress -Depth 10
  [System.IO.File]::AppendAllText("$outDir\uia-enrichments.jsonl", $errLine + "`r`n", [System.Text.Encoding]::UTF8)
  exit 1
}

$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$status = "ok"
$err = $null
$selector = $null

try {
  $point = New-Object System.Windows.Point($X, $Y)
  $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  if ($null -eq $element) {
    $status = "empty"
  } else {
    # Walk up to 3 ancestors via ControlViewWalker
    $parents = @()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $current = $walker.GetParent($element)
    for ($i = 0; $i -lt 3 -and $null -ne $current; $i++) {
      $parentName = ""
      $parentType = ""
      try { $parentName = $current.Current.Name } catch { $parentName = "" }
      try { $parentType = $current.Current.LocalizedControlType } catch { $parentType = "" }
      $parents += @{
        name = $parentName
        control_type = $parentType
      }
      try { $current = $walker.GetParent($current) } catch { $current = $null }
    }

    # Defensive: each Current.* property can throw on stale elements
    $name = ""; $autoId = ""; $ctrlType = ""; $className = ""; $frameworkId = ""
    $isEnabled = $false; $isOffscreen = $false
    $rectX = 0; $rectY = 0; $rectW = 0; $rectH = 0

    try { $name = $element.Current.Name } catch {}
    try { $autoId = $element.Current.AutomationId } catch {}
    try { $ctrlType = $element.Current.LocalizedControlType } catch {}
    try { $className = $element.Current.ClassName } catch {}
    try { $frameworkId = $element.Current.FrameworkId } catch {}
    try { $isEnabled = $element.Current.IsEnabled } catch {}
    try { $isOffscreen = $element.Current.IsOffscreen } catch {}
    try {
      $rect = $element.Current.BoundingRectangle
      $rectX = [int]$rect.X
      $rectY = [int]$rect.Y
      $rectW = [int]$rect.Width
      $rectH = [int]$rect.Height
    } catch {}

    $selector = @{
      name = $name
      automation_id = $autoId
      control_type = $ctrlType
      class_name = $className
      framework_id = $frameworkId
      is_enabled = $isEnabled
      is_offscreen = $isOffscreen
      bounding_rect = @{ x = $rectX; y = $rectY; width = $rectW; height = $rectH }
      parent_chain = $parents
    }
  }
} catch {
  $status = "error"
  $err = $_.Exception.Message
}

$endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$record = [ordered]@{
  event_index = $EventIndex
  uia_query_at = (Get-Date).ToUniversalTime().ToString("o")
  uia_query_duration_ms = ($endMs - $startMs)
  target_uia_selector = $selector
  uia_query_status = $status
  uia_query_error = $err
}

$outPath = "D:\.code\macro-recordings\$SessionId\uia-enrichments.jsonl"
$outDir = Split-Path $outPath -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$jsonLine = $record | ConvertTo-Json -Compress -Depth 10

# Thread-safe append: open with FileShare.ReadWrite, write, close.
# AppendAllText uses FileShare.Read by default which can collide under concurrent writes.
# Use a mutex named per-session to serialise writes.
$mutexName = "Global\uia-probe-$SessionId"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$acquired = $false
try {
  $acquired = $mutex.WaitOne(2000)  # 2s timeout
  if ($acquired) {
    [System.IO.File]::AppendAllText($outPath, $jsonLine + "`r`n", [System.Text.Encoding]::UTF8)
  } else {
    # Fallback: write to a per-event file to avoid loss
    $fallbackPath = "$outDir\uia-enrichments.event-$EventIndex.jsonl"
    [System.IO.File]::WriteAllText($fallbackPath, $jsonLine + "`r`n", [System.Text.Encoding]::UTF8)
  }
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
