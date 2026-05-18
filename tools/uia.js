// uia.js - UI Automation bridge for native Win32 + Electron apps.
//
// Wraps System.Windows.Automation (the legacy UIA-COM/Win32 surface that
// works for ANY Windows app exposing accessibility info). Slower than CDP
// (PowerShell + COM marshalling = 300-800ms per call) but works on apps
// that DON'T have a CDP equivalent: File Explorer, Settings, Task Manager,
// any native dialog, plus most Electron apps.
//
// Pattern: pass a window selector ({ pid?, titleContains?, exe?, className? })
// to bind to a top-level window, then queries within that window.
//
// Note: Electron apps (VS Code, Cursor, Slack, etc.) typically need their
// accessibility tree "woken up" by querying once. UIA does this implicitly
// on the first FindFirst call.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

function runPs(script, timeoutMs) {
  timeoutMs = timeoutMs || 12000
  const tmp = path.join(os.tmpdir(), 'eos-uia-' + Date.now() + '.ps1')
  fs.writeFileSync(tmp, script, 'utf8')
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    return { exitCode: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

const UIA_PRELUDE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
function Find-TopWindow {
  param($selector)
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $children) {
    try {
      $name = $w.Current.Name
      $cn = $w.Current.ClassName
      $pid = $w.Current.ProcessId
      $matchPid = $true; $matchTitle = $true; $matchExe = $true; $matchClass = $true
      if ($selector.pid) { $matchPid = ($pid -eq $selector.pid) }
      if ($selector.titleContains) { $matchTitle = ($name -like ('*' + $selector.titleContains + '*')) }
      if ($selector.className) { $matchClass = ($cn -eq $selector.className) }
      if ($selector.exe) {
        try { $p = Get-Process -Id $pid -ErrorAction Stop; $matchExe = ($p.ProcessName -ieq $selector.exe -or $p.ProcessName -ieq ($selector.exe -replace '\\.exe\$','')) } catch { $matchExe = $false }
      }
      if ($matchPid -and $matchTitle -and $matchExe -and $matchClass) { return $w }
    } catch {}
  }
  return $null
}
`

// uia.windows - list top-level UIA-visible windows. Cheaper than uia.tree.
async function uiaWindows() {
  const script = UIA_PRELUDE + `
$out = New-Object System.Collections.ArrayList
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $children) {
  try {
    $name = $w.Current.Name
    if ($name.Length -eq 0) { continue }
    [void]$out.Add(@{ name = $name; className = $w.Current.ClassName; pid = $w.Current.ProcessId })
  } catch {}
}
$out | ConvertTo-Json -Compress
`
  const r = runPs(script, 10000)
  if (r.exitCode !== 0) throw new Error('uia.windows PS failed: ' + r.stderr)
  let arr; try { arr = JSON.parse(r.stdout) } catch (e) { arr = [] }
  if (!Array.isArray(arr)) arr = [arr]
  return { count: arr.length, windows: arr }
}

// uia.tree - dump the accessibility tree of one top-level window.
// Use sparingly (can be slow + big for complex apps).
async function uiaTree(params) {
  params = params || {}
  const depth = Math.max(1, Math.min(params.depth || 4, 8))
  const sel = JSON.stringify({
    pid: params.pid || null,
    titleContains: params.titleContains || null,
    exe: params.exe || null,
    className: params.className || null,
  })
  const script = UIA_PRELUDE + `
$selector = '${sel.replace(/'/g, "''")}' | ConvertFrom-Json
$top = Find-TopWindow $selector
if (-not $top) { Write-Output 'NO_TOP_WINDOW'; exit 0 }
function Walk-Tree {
  param($el, $depth, $maxDepth)
  if ($depth -gt $maxDepth) { return $null }
  try {
    $c = $el.Current
    $node = @{
      name = $c.Name
      className = $c.ClassName
      automationId = $c.AutomationId
      controlType = $c.ControlType.LocalizedControlType
      isEnabled = $c.IsEnabled
      isOffscreen = $c.IsOffscreen
      bounds = @($c.BoundingRectangle.X, $c.BoundingRectangle.Y, $c.BoundingRectangle.Width, $c.BoundingRectangle.Height)
      children = @()
    }
    if ($depth -lt $maxDepth) {
      $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($k in $kids) {
        $child = Walk-Tree $k ($depth + 1) $maxDepth
        if ($child) { $node.children += , $child }
      }
    }
    return $node
  } catch { return $null }
}
$tree = Walk-Tree $top 0 ${depth}
$tree | ConvertTo-Json -Depth ${depth + 2} -Compress
`
  const r = runPs(script, 30000)
  if (r.exitCode !== 0) throw new Error('uia.tree PS failed: ' + r.stderr)
  if (r.stdout === 'NO_TOP_WINDOW') return { ok: false, error: 'no matching top-level window' }
  let tree; try { tree = JSON.parse(r.stdout) } catch (e) { return { ok: false, error: 'tree parse failed', raw: r.stdout.slice(0, 500) } }
  return { ok: true, tree: tree }
}

// uia.find - find one element matching properties inside a window.
async function uiaFind(params) {
  params = params || {}
  const sel = JSON.stringify({
    pid: params.pid || null,
    titleContains: params.titleContains || null,
    exe: params.exe || null,
    className: params.className || null,
  })
  const findName = params.name || null
  const findAutomationId = params.automationId || null
  const findControlType = params.controlType || null
  const findClassName = params.elementClassName || null
  const script = UIA_PRELUDE + `
$selector = '${sel.replace(/'/g, "''")}' | ConvertFrom-Json
$top = Find-TopWindow $selector
if (-not $top) { Write-Output 'NO_TOP_WINDOW'; exit 0 }
$conds = @()
${findName ? `$conds += [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '${findName.replace(/'/g, "''")}')` : ''}
${findAutomationId ? `$conds += [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${findAutomationId.replace(/'/g, "''")}')` : ''}
${findClassName ? `$conds += [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, '${findClassName.replace(/'/g, "''")}')` : ''}
if ($conds.Count -eq 0) { Write-Output 'NO_CONDITIONS'; exit 0 }
$cond = if ($conds.Count -eq 1) { $conds[0] } else { [System.Windows.Automation.AndCondition]::new($conds) }
$el = $top.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { Write-Output 'NOT_FOUND'; exit 0 }
$c = $el.Current
@{ name = $c.Name; className = $c.ClassName; automationId = $c.AutomationId; controlType = $c.ControlType.LocalizedControlType; bounds = @($c.BoundingRectangle.X, $c.BoundingRectangle.Y, $c.BoundingRectangle.Width, $c.BoundingRectangle.Height); isEnabled = $c.IsEnabled } | ConvertTo-Json -Compress
`
  const r = runPs(script, 15000)
  if (r.exitCode !== 0) throw new Error('uia.find PS failed: ' + r.stderr)
  if (r.stdout === 'NO_TOP_WINDOW') return { ok: false, error: 'no matching window' }
  if (r.stdout === 'NOT_FOUND') return { ok: false, error: 'element not found in window' }
  if (r.stdout === 'NO_CONDITIONS') return { ok: false, error: 'must specify name, automationId, or elementClassName' }
  let el; try { el = JSON.parse(r.stdout) } catch (e) { return { ok: false, error: 'parse failed' } }
  return { ok: true, element: el }
}

// uia.invoke - find a named element and invoke (click) it via InvokePattern.
async function uiaInvoke(params) {
  params = params || {}
  const sel = JSON.stringify({
    pid: params.pid || null,
    titleContains: params.titleContains || null,
    exe: params.exe || null,
    className: params.className || null,
  })
  const findName = params.name || ''
  if (!findName) throw new Error('name required')
  const script = UIA_PRELUDE + `
$selector = '${sel.replace(/'/g, "''")}' | ConvertFrom-Json
$top = Find-TopWindow $selector
if (-not $top) { Write-Output 'NO_TOP_WINDOW'; exit 0 }
$cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '${findName.replace(/'/g, "''")}')
$el = $top.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { Write-Output 'NOT_FOUND'; exit 0 }
$ip = $null
try { $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch {}
if (-not $ip) {
  try { $ip = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $ip.Select(); Write-Output 'SELECTED'; exit 0 } catch {}
  Write-Output 'NO_INVOKE_PATTERN'; exit 0
}
$ip.Invoke()
Write-Output 'INVOKED'
`
  const r = runPs(script, 15000)
  if (r.exitCode !== 0) throw new Error('uia.invoke PS failed: ' + r.stderr)
  if (r.stdout.indexOf('NO_TOP_WINDOW') >= 0) return { ok: false, error: 'no matching window' }
  if (r.stdout.indexOf('NOT_FOUND') >= 0) return { ok: false, error: 'element not found' }
  if (r.stdout.indexOf('NO_INVOKE_PATTERN') >= 0) return { ok: false, error: 'element does not support Invoke' }
  return { ok: true, action: r.stdout.trim() }
}

// uia.set_value - set text in an editable element via ValuePattern.
async function uiaSetValue(params) {
  params = params || {}
  const sel = JSON.stringify({
    pid: params.pid || null,
    titleContains: params.titleContains || null,
    exe: params.exe || null,
    className: params.className || null,
  })
  const findName = params.name || ''
  const value = params.value
  if (!findName) throw new Error('name required')
  if (typeof value !== 'string') throw new Error('value (string) required')
  const script = UIA_PRELUDE + `
$selector = '${sel.replace(/'/g, "''")}' | ConvertFrom-Json
$top = Find-TopWindow $selector
if (-not $top) { Write-Output 'NO_TOP_WINDOW'; exit 0 }
$cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '${findName.replace(/'/g, "''")}')
$el = $top.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { Write-Output 'NOT_FOUND'; exit 0 }
$vp = $null
try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
if (-not $vp) { Write-Output 'NO_VALUE_PATTERN'; exit 0 }
$vp.SetValue('${value.replace(/'/g, "''")}')
Write-Output 'SET'
`
  const r = runPs(script, 15000)
  if (r.exitCode !== 0) throw new Error('uia.set_value PS failed: ' + r.stderr)
  if (r.stdout.indexOf('NO_TOP_WINDOW') >= 0) return { ok: false, error: 'no matching window' }
  if (r.stdout.indexOf('NOT_FOUND') >= 0) return { ok: false, error: 'element not found' }
  if (r.stdout.indexOf('NO_VALUE_PATTERN') >= 0) return { ok: false, error: 'element does not support Value (read-only or not editable)' }
  return { ok: true, action: 'set' }
}

module.exports = {
  windows: uiaWindows,
  tree: uiaTree,
  find: uiaFind,
  invoke: uiaInvoke,
  set_value: uiaSetValue,
}
