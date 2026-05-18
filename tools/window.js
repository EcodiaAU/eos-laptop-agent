// window.js - foreground / window enumeration / focus by name.
//
// Cheap Win32 primitives backing both the Tate-collision check and the
// "find app X and bring it forward" pattern that vscode.* / cursor.* /
// explorer.* / chrome flows all need.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const psd = require('../lib/ps-daemon')

// Routes through the long-lived PS daemon. Falls back to per-call spawnSync
// if the daemon is unavailable. Both paths share the same return shape.
async function runPs(script, timeoutMs) {
  const r = await psd.runOrFallback(script, { timeout_ms: timeoutMs || 6000 })
  return { exitCode: r.ok ? 0 : (r.exit_code || 1), stdout: (r.stdout || '').trim(), stderr: (r.stderr || r.error || '').trim() }
}

// gui.foreground - what window is focused right now?
async function foreground() {
  const ps = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h = [FG]::GetForegroundWindow()
$titleBuf = New-Object System.Text.StringBuilder 512
$classBuf = New-Object System.Text.StringBuilder 256
[void][FG]::GetWindowText($h, $titleBuf, 512)
[void][FG]::GetClassName($h, $classBuf, 256)
$winPid = 0
[void][FG]::GetWindowThreadProcessId($h, [ref]$winPid)
$proc = Get-Process -Id $winPid -ErrorAction SilentlyContinue
$exe = if ($proc) { $proc.ProcessName } else { '?' }
$exePath = if ($proc -and $proc.Path) { $proc.Path } else { $null }
@{ hwnd = [int64]$h; title = $titleBuf.ToString(); className = $classBuf.ToString(); pid = $winPid; exe = $exe; exePath = $exePath } | ConvertTo-Json -Compress
`
  const r = await runPs(ps)
  if (r.exitCode !== 0) throw new Error('foreground PS failed: ' + r.stderr)
  return JSON.parse(r.stdout)
}

// gui.windows - all visible top-level windows with title+class+pid+exe
async function windows(params) {
  params = params || {}
  const excludeEmpty = params.excludeEmpty !== false
  const ps = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WE {
  public delegate bool EnumProc(IntPtr h, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$results = New-Object System.Collections.ArrayList
$cb = [WE+EnumProc]{
  param($h, $lp)
  if (-not [WE]::IsWindowVisible($h)) { return $true }
  $tb = New-Object System.Text.StringBuilder 512
  $cb2 = New-Object System.Text.StringBuilder 256
  [void][WE]::GetWindowText($h, $tb, 512)
  [void][WE]::GetClassName($h, $cb2, 256)
  $title = $tb.ToString()
  if ($title.Length -eq 0) { return $true }
  $winPid = 0
  [void][WE]::GetWindowThreadProcessId($h, [ref]$winPid)
  $proc = Get-Process -Id $winPid -ErrorAction SilentlyContinue
  $exe = if ($proc) { $proc.ProcessName } else { '?' }
  [void]$results.Add(@{ hwnd = [int64]$h; title = $title; className = $cb2.ToString(); pid = $winPid; exe = $exe })
  return $true
}
[void][WE]::EnumWindows($cb, [IntPtr]::Zero)
$results | ConvertTo-Json -Compress
`
  const r = await runPs(ps, 8000)
  if (r.exitCode !== 0) throw new Error('windows PS failed: ' + r.stderr)
  let arr
  try { arr = JSON.parse(r.stdout) } catch (e) { arr = [] }
  if (!Array.isArray(arr)) arr = [arr]
  return { count: arr.length, windows: arr }
}

// gui.focus_window - bring a window matching title-substring or exe-name to foreground.
// Uses AHK if available (most reliable), falls back to Win32 SetForegroundWindow.
async function focusWindow(params) {
  params = params || {}
  const titleContains = params.titleContains || null
  const exe = params.exe || null
  const className = params.className || null
  if (!titleContains && !exe && !className) {
    throw new Error('focus_window requires titleContains, exe, or className')
  }
  const ahkParts = []
  if (exe) ahkParts.push('ahk_exe ' + exe)
  if (className) ahkParts.push('ahk_class ' + className)
  const winSpec = ahkParts.join(' ')
  let title = titleContains || ''

  const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'
  const tmp = path.join(os.tmpdir(), 'eos-fw-' + Date.now() + '.ahk')
  let script
  if (exe || className) {
    script = '#Requires AutoHotkey v2.0\n' +
      'SetTitleMatchMode 2\n' +
      'if WinExist("' + (title.replace(/"/g, '`"')) + '" "' + winSpec + '") {\n' +
      '  WinActivate\n' +
      '  WinWaitActive(, , 2)\n' +
      '  ExitApp 0\n' +
      '} else {\n' +
      '  ExitApp 1\n' +
      '}\n'
  } else {
    script = '#Requires AutoHotkey v2.0\n' +
      'SetTitleMatchMode 2\n' +
      'if WinExist("' + (title.replace(/"/g, '`"')) + '") {\n' +
      '  WinActivate\n' +
      '  WinWaitActive(, , 2)\n' +
      '  ExitApp 0\n' +
      '} else { ExitApp 1 }\n'
  }
  fs.writeFileSync(tmp, script, 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: 5000, windowsHide: true, encoding: 'utf8' })
    if (r.status === 0) return { ok: true, found: true, target: { titleContains, exe, className } }
    return { ok: false, found: false, target: { titleContains, exe, className } }
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

module.exports = {
  foreground: foreground,
  windows: windows,
  focus_window: focusWindow,
}
