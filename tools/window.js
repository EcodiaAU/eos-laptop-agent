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
    const r = spawnSync(AHK, [tmp], { timeout: 5000, windowsHide: true, encoding: 'utf8', creationFlags: 0x08000000 /* CREATE_NO_WINDOW - prevents console flash that steals focus mid-keystroke */ })
    if (r.status === 0) return { ok: true, found: true, target: { titleContains, exe, className } }
    return { ok: false, found: false, target: { titleContains, exe, className } }
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

// gui.focus_and_send - atomic WinActivate + Send-Key in a SINGLE AHK script.
//
// Replaces the two-call dance (focus_window + sleep + input.key) used by
// cowork.dispatch_worker to submit the prefilled CC chat. The two-call form
// had a 300ms+ Node-side window between activation and keystroke during which
// OS focus could drift (a console flash, the user touching another window,
// VS Code re-routing focus to a non-webview element), so the keystroke landed
// nowhere or somewhere wrong. Empirically ~70% of scheduler-dispatched
// workers orphaned because Enter never reached the chat textarea.
//
// This helper runs WinActivate, WinWaitActive, an optional brief settle Sleep,
// then SendInput in the SAME AHK process - microseconds between the focus and
// the keystroke, no Node turn in between. Returns ok=true on AHK exit-zero
// (activated + key sent), false otherwise. AHK cannot detect what consumed
// the keystroke - reliability is verified downstream via the worker ack
// (coord heartbeat advance) in cowork.dispatch_worker's orphan-detect loop.
async function focusAndSend(params) {
  params = params || {}
  const exe = params.exe || 'Code.exe'
  // 2026-06-02: caller may pass an OS hwnd (uint) to disambiguate when multiple
  // windows of the same exe are alive. Prefer hwnd over pid because VS Code's
  // ide-bridge runs in the extension host - a child process that owns NO OS
  // window. ahk_pid <extension_host_pid> returns no_matching_window. The hwnd
  // must come from window.windows() filtering on the main Code.exe instance
  // that hosts the bridge (matched by workspaceRoots in the title).
  const hwnd = params.hwnd && Number.isInteger(Number(params.hwnd)) ? Number(params.hwnd) : null
  const key = String(params.key || 'enter').toLowerCase()
  const settleMs = Math.max(0, Math.min(2000, params.settleMs == null ? 250 : Number(params.settleMs)))
  const KEY_MAP = {
    enter: '{Enter}', return: '{Enter}',
    'ctrl+enter': '^{Enter}', 'ctrl-enter': '^{Enter}', ctrl_enter: '^{Enter}',
    'shift+enter': '+{Enter}', 'shift-enter': '+{Enter}', shift_enter: '+{Enter}',
    tab: '{Tab}', escape: '{Esc}', esc: '{Esc}', space: '{Space}',
    up: '{Up}', down: '{Down}', left: '{Left}', right: '{Right}',
  }
  const ahkKey = KEY_MAP[key] || ('{' + key.toUpperCase() + '}')
  const safeExe = exe.replace(/"/g, '`"')

  const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'
  const tmp = path.join(os.tmpdir(), 'eos-fas-' + Date.now() + '-' + process.pid + '.ahk')
  // Activation order:
  //   1. Try plain WinActivate first. If the window is not currently fighting
  //      ForegroundLock (the common case when VS Code is already in the
  //      foreground-recent set), this succeeds instantly and we skip the
  //      Alt-keystroke entirely. Skipping Alt matters because when VS Code is
  //      already focused, a bare Alt keystroke activates the menu bar - then
  //      the SendInput Enter that follows opens File > New File instead of
  //      submitting the chat (the exact regression observed on 2026-05-31).
  //   2. If WinWaitActive times out, ForegroundLock IS blocking us. Only then
  //      do we use the AttachThreadInput trick to hand foreground over -
  //      AttachThreadInput-based transfer does NOT need an Alt-keystroke
  //      because it doesn't rely on input-ownership at all.
  //   3. If the AttachThreadInput path also fails, fall back to the Alt
  //      keystroke trick as the last-resort ForegroundLock buster. At this
  //      point VS Code is NOT yet foreground, so Alt activating the menu is
  //      on some OTHER window, not VS Code - the subsequent WinActivate
  //      drops VS Code foreground and Enter lands in the chat textarea.
  // Target spec: prefer hwnd for exact-window match, fall back to exe for
  // single-window installs.
  const winSpec = hwnd ? 'ahk_id ' + hwnd : 'ahk_exe ' + safeExe
  const script =
    '#Requires AutoHotkey v2.0\n' +
    'SetTitleMatchMode 2\n' +
    'if !WinExist("' + winSpec + '") {\n' +
    '  ExitApp 1\n' +
    '}\n' +
    'targetHwnd := WinExist()\n' +
    'WinActivate\n' +
    'if !WinWaitActive(, , 0.6) {\n' +
    '  ; AttachThreadInput foreground transfer (no input-ownership Alt needed)\n' +
    '  targetThread := DllCall("GetWindowThreadProcessId", "Ptr", targetHwnd, "UInt*", 0)\n' +
    '  fgHwnd := DllCall("GetForegroundWindow", "Ptr")\n' +
    '  fgThread := DllCall("GetWindowThreadProcessId", "Ptr", fgHwnd, "UInt*", 0)\n' +
    '  DllCall("AttachThreadInput", "UInt", fgThread, "UInt", targetThread, "Int", 1)\n' +
    '  DllCall("SetForegroundWindow", "Ptr", targetHwnd)\n' +
    '  DllCall("AttachThreadInput", "UInt", fgThread, "UInt", targetThread, "Int", 0)\n' +
    '  WinWaitActive(, , 0.6)\n' +
    '}\n' +
    'if !WinActive("' + winSpec + '") {\n' +
    '  ; Last resort: Alt-keystroke ForegroundLock buster. Only fires when\n' +
    '  ; AttachThreadInput failed - VS Code is NOT foreground at this point,\n' +
    '  ; so Alt activates some other windows menu (or no menu) before our\n' +
    '  ; subsequent WinActivate moves us into VS Code.\n' +
    '  Send "{Alt down}{Alt up}"\n' +
    '  Sleep 30\n' +
    '  WinActivate\n' +
    '  WinWaitActive(, , 0.6)\n' +
    '}\n' +
    'if WinActive("' + winSpec + '") {\n' +
    '  Sleep ' + settleMs + '\n' +
    '  SendInput "' + ahkKey + '"\n' +
    '  ExitApp 0\n' +
    '}\n' +
    'ExitApp 2\n'
  fs.writeFileSync(tmp, script, 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: 6000, windowsHide: true, encoding: 'utf8', creationFlags: 0x08000000 /* CREATE_NO_WINDOW - prevents console flash that steals focus mid-keystroke */ })
    return {
      ok: r.status === 0,
      status: r.status,
      target: { exe, key },
      settle_ms: settleMs,
      reason: r.status === 0 ? 'activated_and_sent'
            : r.status === 1 ? 'no_matching_window'
            : r.status === 2 ? 'activate_failed_within_1500ms'
            : 'ahk_error',
    }
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

module.exports = {
  foreground: foreground,
  windows: windows,
  focus_window: focusWindow,
  focus_and_send: focusAndSend,
}
