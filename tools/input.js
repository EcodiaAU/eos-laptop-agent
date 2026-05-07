const { execSync, spawnSync } = require('child_process')

// Windows CREATE_NO_WINDOW flag - prevents cmd/powershell window flash on every input call.
// 29 Apr 2026 12:42 AEST patch: shell.js was patched but input.js + screenshot.js still flashed.
const CREATE_NO_WINDOW = 0x08000000

function runHidden(file, args, options = {}) {
  if (process.platform === 'win32') {
    // spawnSync DOES respect creationFlags - libuv passes it through to CreateProcess.
    // CREATE_NO_WINDOW prevents the powershell console window from appearing at all,
    // which windowsHide:true alone cannot do when the parent (PM2 daemon) has a console.
    const r = spawnSync(file, args, {
      encoding: 'utf-8',
      timeout: options.timeout || 15000,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: false,
      detached: false,
      creationFlags: CREATE_NO_WINDOW,
    })
    if (r.error) throw r.error
    if (r.status !== 0) {
      const err = new Error('Command failed: ' + file + ' status=' + r.status + ' stderr=' + (r.stderr || ''))
      err.status = r.status
      err.stdout = r.stdout
      err.stderr = r.stderr
      throw err
    }
    return r.stdout || ''
  }
  return execSync(file + ' ' + args.map(a => '"' + a.replace(/"/g, '\\"') + '"').join(' '), { encoding: 'utf-8', timeout: options.timeout || 15000 })
}
const fs = require('fs')
const path = require('path')
const os = require('os')
const { isWindows, isMac, isLinux } = require('../lib/platform')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runPs(script) {
  const tmpFile = path.join(os.tmpdir(), `eos-input-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`)
  try {
    fs.writeFileSync(tmpFile, script, 'utf-8')
    return runHidden('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile], { timeout: 15000 })
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  }
}

function runCli(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 15000 })
}

// Escape text for PowerShell SendKeys.SendWait().
// Special chars that SendKeys interprets: + ^ % ~ ( ) { } [ ]
// Each must be wrapped in braces, e.g. {+}, {^}, etc.
// We also need to handle single quotes inside a PS single-quoted string: '' => escape by doubling.
function escapeSendKeys(text) {
  return text.replace(/[+^%~(){}[\]]/g, ch => `{${ch}}`)
}

// Translate modifier array + key into SendKeys notation.
// modifiers: ['ctrl','alt','shift','cmd']  key: 'a', 'enter', 'f5', etc.
const SENDKEYS_MOD = { ctrl: '^', alt: '%', shift: '+', cmd: '^' }
const SENDKEYS_SPECIAL = {
  enter: '{ENTER}', return: '{ENTER}',
  tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
  home: '{HOME}', end: '{END}',
  pageup: '{PGUP}', pagedown: '{PGDN}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}',
  f6: '{F6}', f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}',
  f11: '{F11}', f12: '{F12}',
  space: ' ', insert: '{INSERT}',
  printscreen: '{PRTSC}', scrolllock: '{SCROLLLOCK}', numlock: '{NUMLOCK}',
}

function toSendKeys(key, modifiers) {
  const k = key.toLowerCase()
  const mapped = SENDKEYS_SPECIAL[k] || (k.length === 1 ? k : `{${key.toUpperCase()}}`)
  if (!modifiers || modifiers.length === 0) return mapped
  const prefix = modifiers.map(m => SENDKEYS_MOD[m.toLowerCase()] || '').join('')
  // If multiple modifiers, wrap the key: e.g. ^+(k)
  return modifiers.length > 1 ? `${prefix}(${mapped})` : `${prefix}${mapped}`
}

// Translate modifier+key string like "ctrl+shift+p" into SendKeys notation.
function parseShortcutToSendKeys(keys) {
  const parts = (Array.isArray(keys) ? keys.join('+') : keys)
    .toLowerCase()
    .split('+')
    .map(s => s.trim())
  const modifierNames = ['ctrl', 'alt', 'shift', 'cmd', 'win', 'super']
  const mods = parts.filter(p => modifierNames.includes(p))
  const keyParts = parts.filter(p => !modifierNames.includes(p))
  if (keyParts.length === 0) throw new Error('No key specified in shortcut')
  const key = keyParts[keyParts.length - 1]
  return toSendKeys(key, mods)
}

// Translate a key name to a cliclick key code (Mac).
const CLICLICK_KEYS = {
  enter: 'return', return: 'return',
  tab: 'tab', escape: 'esc', esc: 'esc',
  backspace: 'delete', delete: 'fwd-delete',
  home: 'home', end: 'end',
  pageup: 'page-up', pagedown: 'page-down',
  up: 'arrow-up', down: 'arrow-down', left: 'arrow-left', right: 'arrow-right',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5',
  f6: 'f6', f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10',
  f11: 'f11', f12: 'f12',
  space: 'space',
}

const CLICLICK_MOD = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'cmd' }

// Translate modifier array + key into a cliclick key-press command.
// e.g. kd:cmd t:"s" ku:cmd
function toCliclick(key, modifiers) {
  const k = CLICLICK_KEYS[key.toLowerCase()] || key.toLowerCase()
  if (!modifiers || modifiers.length === 0) {
    return `kp:${k}`
  }
  const mods = modifiers.map(m => CLICLICK_MOD[m.toLowerCase()] || m).join(',')
  return `kd:${mods} kp:${k} ku:${mods}`
}

// Translate shortcut string/array into a cliclick command string.
function parseShortcutToCliclick(keys) {
  const parts = (Array.isArray(keys) ? keys.join('+') : keys)
    .toLowerCase()
    .split('+')
    .map(s => s.trim())
  const modifierNames = ['ctrl', 'alt', 'shift', 'cmd', 'win', 'super']
  const mods = parts.filter(p => modifierNames.includes(p))
  const keyParts = parts.filter(p => !modifierNames.includes(p))
  if (keyParts.length === 0) throw new Error('No key specified in shortcut')
  const key = CLICLICK_KEYS[keyParts[keyParts.length - 1]] || keyParts[keyParts.length - 1]
  if (mods.length === 0) return `kp:${key}`
  const modStr = mods.map(m => CLICLICK_MOD[m] || m).join(',')
  return `kd:${modStr} kp:${key} ku:${modStr}`
}

function requireCliclick() {
  try {
    execSync('which cliclick', { encoding: 'utf-8', timeout: 3000 })
  } catch {
    throw new Error('cliclick not installed. Run: brew install cliclick')
  }
}

// xdotool key name mapping for Linux
const XDOTOOL_KEYS = {
  enter: 'Return', return: 'Return',
  tab: 'Tab', escape: 'Escape', esc: 'Escape',
  backspace: 'BackSpace', delete: 'Delete',
  home: 'Home', end: 'End',
  pageup: 'Page_Up', pagedown: 'Page_Down',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  space: 'space',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5',
  f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10',
  f11: 'F11', f12: 'F12',
}

const XDOTOOL_MOD = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'super', win: 'super', super: 'super' }

function toXdotool(key, modifiers) {
  const k = XDOTOOL_KEYS[key.toLowerCase()] || key
  if (!modifiers || modifiers.length === 0) return k
  const prefix = modifiers.map(m => XDOTOOL_MOD[m.toLowerCase()] || m).join('+')
  return `${prefix}+${k}`
}

function parseShortcutToXdotool(keys) {
  const parts = (Array.isArray(keys) ? keys.join('+') : keys)
    .toLowerCase()
    .split('+')
    .map(s => s.trim())
  const modifierNames = ['ctrl', 'alt', 'shift', 'cmd', 'win', 'super']
  const mods = parts.filter(p => modifierNames.includes(p))
  const keyParts = parts.filter(p => !modifierNames.includes(p))
  if (keyParts.length === 0) throw new Error('No key specified in shortcut')
  const key = XDOTOOL_KEYS[keyParts[keyParts.length - 1]] || keyParts[keyParts.length - 1]
  if (mods.length === 0) return key
  const prefix = mods.map(m => XDOTOOL_MOD[m] || m).join('+')
  return `${prefix}+${key}`
}

// Button flag helpers for Windows mouse_event
const WIN_BUTTON_DOWN = { left: '0x0002', right: '0x0008', middle: '0x0020' }
const WIN_BUTTON_UP   = { left: '0x0004', right: '0x0010', middle: '0x0040' }

// ---------------------------------------------------------------------------
// click
// ---------------------------------------------------------------------------

async function click({ x, y, button = 'left', double = false }) {
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('x and y are required numbers')
  const btn = (button || 'left').toLowerCase()
  if (!['left', 'right', 'middle'].includes(btn)) throw new Error('button must be left, right, or middle')

  if (isWindows) {
    const down = WIN_BUTTON_DOWN[btn]
    const up   = WIN_BUTTON_UP[btn]
    const clicks = double ? 2 : 1
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
'@ -Name MouseOps -Namespace Win32Api
$clicks = ${clicks}
for ($i = 0; $i -lt $clicks; $i++) {
  [Win32Api.MouseOps]::mouse_event(${down}, 0, 0, 0, 0)
  [Win32Api.MouseOps]::mouse_event(${up}, 0, 0, 0, 0)
  if ($i -lt $clicks - 1) { Start-Sleep -Milliseconds 50 }
}
Write-Output "ok"
`
    runPs(ps)
    return { ok: true }
  }

  if (isMac) {
    requireCliclick()
    const flag = double ? 'dc' : (btn === 'right' ? 'rc' : btn === 'middle' ? 'mc' : 'c')
    runCli(`cliclick ${flag}:${x},${y}`)
    return { ok: true }
  }

  if (isLinux) {
    const btnNum = btn === 'right' ? 3 : btn === 'middle' ? 2 : 1
    runCli(`xdotool mousemove ${x} ${y} click${double ? ' --repeat 2' : ''} ${btnNum}`)
    return { ok: true }
  }

  throw new Error(`Unsupported platform: ${os.platform()}`)
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

async function move({ x, y, duration = 0 }) {
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('x and y are required numbers')
  const dur = duration || 0

  if (isWindows) {
    const steps = dur > 0 ? Math.max(Math.round(dur / 10), 2) : 1
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$startPos = [System.Windows.Forms.Cursor]::Position
$endX = ${x}
$endY = ${y}
$steps = ${steps}
for ($i = 1; $i -le $steps; $i++) {
  $nx = [int]($startPos.X + ($endX - $startPos.X) * $i / $steps)
  $ny = [int]($startPos.Y + ($endY - $startPos.Y) * $i / $steps)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($nx, $ny)
  if ($steps -gt 1) { Start-Sleep -Milliseconds ${Math.max(Math.round(dur / Math.max(steps, 1)), 1)} }
}
Write-Output "ok"
`
    runPs(ps)
    return { ok: true }
  }

  if (isMac) {
    requireCliclick()
    if (dur > 0) {
      runCli(`cliclick -w ${dur} m:${x},${y}`)
    } else {
      runCli(`cliclick m:${x},${y}`)
    }
    return { ok: true }
  }

  if (isLinux) {
    if (dur > 0) {
      runCli(`xdotool mousemove --delay ${dur} ${x} ${y}`)
    } else {
      runCli(`xdotool mousemove ${x} ${y}`)
    }
    return { ok: true }
  }

  throw new Error(`Unsupported platform: ${os.platform()}`)
}

// ---------------------------------------------------------------------------
// type
// ---------------------------------------------------------------------------

async function type({ text, delay = 0 }) {
  if (typeof text !== 'string') throw new Error('text is required and must be a string')
  const del = delay || 0

  if (isWindows) {
    const escaped = escapeSendKeys(text)
    // Use single-quoted PS string to avoid PS variable interpolation.
    // Single quotes in the escaped string are not possible since we wrapped in single quotes —
    // SendKeys special chars are already brace-escaped, so no literal single quotes can appear.
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
${del > 0 ? `
$chars = @(${[...escaped].map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
foreach ($c in $chars) {
  [System.Windows.Forms.SendKeys]::SendWait($c)
  Start-Sleep -Milliseconds ${del}
}
` : `[System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')`}
Write-Output "ok"
`
    runPs(ps)
    return { ok: true, chars: text.length }
  }

  if (isMac) {
    requireCliclick()
    // cliclick t: handles plain text. For delay we type char by char.
    // Escape double quotes and backslashes for shell.
    if (del > 0) {
      for (const ch of text) {
        const escaped = ch.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        runCli(`cliclick t:"${escaped}"`)
        if (process.platform === 'win32') {
          // Use Node's setTimeout-equivalent (sync wait via Atomics) instead of cmd.exe sleep
          const end = Date.now() + del
          while (Date.now() < end) { /* spin-wait for short delays */ }
        } else {
          execSync(`sleep ${(del / 1000).toFixed(3)}`, { timeout: del + 1000 })
        }
      }
    } else {
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      runCli(`cliclick t:"${escaped}"`)
    }
    return { ok: true, chars: text.length }
  }

  if (isLinux) {
    const escapedForShell = text.replace(/'/g, "'\\''")
    if (del > 0) {
      runCli(`xdotool type --delay ${del} '${escapedForShell}'`)
    } else {
      runCli(`xdotool type '${escapedForShell}'`)
    }
    return { ok: true, chars: text.length }
  }

  throw new Error(`Unsupported platform: ${os.platform()}`)
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

async function key({ key: keyName, modifiers = [] }) {
  if (!keyName) throw new Error('key is required')

  if (isWindows) {
    const sk = toSendKeys(keyName, modifiers)
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sk.replace(/'/g, "''")}')
Write-Output "ok"
`
    runPs(ps)
    return { ok: true }
  }

  if (isMac) {
    requireCliclick()
    const cc = toCliclick(keyName, modifiers)
    runCli(`cliclick ${cc}`)
    return { ok: true }
  }

  if (isLinux) {
    const xk = toXdotool(keyName, modifiers)
    runCli(`xdotool key ${xk}`)
    return { ok: true }
  }

  throw new Error(`Unsupported platform: ${os.platform()}`)
}

// ---------------------------------------------------------------------------
// shortcut
// ---------------------------------------------------------------------------

async function shortcut({ keys }) {
  if (!keys) throw new Error('keys is required')

  if (isWindows) {
    const sk = parseShortcutToSendKeys(keys)
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sk.replace(/'/g, "''")}')
Write-Output "ok"
`
    runPs(ps)
    return { ok: true }
  }

  if (isMac) {
    requireCliclick()
    const cc = parseShortcutToCliclick(keys)
    runCli(`cliclick ${cc}`)
    return { ok: true }
  }

  if (isLinux) {
    const xk = parseShortcutToXdotool(keys)
    runCli(`xdotool key ${xk}`)
    return { ok: true }
  }

  throw new Error(`Unsupported platform: ${os.platform()}`)
}

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

async function drag({ fromX, fromY, toX, toY, button = 'left', duration = 200 }) {
  if ([fromX, fromY, toX, toY].some(v => typeof v !== 'number')) {
    throw new Error('fromX, fromY, toX, toY are required numbers')
  }
  const btn = (button || 'left').toLowerCase()
  if (!['left', 'right', 'middle'].includes(btn)) throw new Error('button must be left, right, or middle')
  const dur = duration || 200
  const steps = Math.max(Math.round(dur / 10), 5)

  if (isWindows) {
    const down = WIN_BUTTON_DOWN[btn]
    const up   = WIN_BUTTON_UP[btn]
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
'@ -Name MouseOps -Namespace Win32Api
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${fromX}, ${fromY})
[Win32Api.MouseOps]::mouse_event(${down}, 0, 0, 0, 0)
$steps = ${steps}
$sleepMs = [int](${dur} / $steps)
for ($i = 1; $i -le $steps; $i++) {
  $nx = [int](${fromX} + (${toX} - ${fromX}) * $i / $steps)
  $ny = [int](${fromY} + (${toY} - ${fromY}) * $i / $steps)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($nx, $ny)
  Start-Sleep -Milliseconds $sleepMs
}
[Win32Api.MouseOps]::mouse_event(${up}, 0, 0, 0, 0)
Write-Output "ok"
`
    runPs(ps)
    return { ok: true }
  }

  if (isMac) {
    requireCliclick()
    runCli(`cliclick dd:${fromX},${fromY} -w ${dur} du:${toX},${toY}`)
    return { ok: true }
  }

  if (isLinux) {
    const btnNum = btn === 'right' ? 3 : btn === 'middle' ? 2 : 1
    runCli(`xdotool mousemove ${fromX} ${fromY} mousedown ${btnNum} mousemove --delay ${dur} ${toX} ${toY} mouseup ${btnNum}`)
    return { ok: true }
  }

  throw new Error(`Unsupported platform: ${os.platform()}`)
}

// ---------------------------------------------------------------------------
// cursorPosition
// ---------------------------------------------------------------------------

async function cursorPosition() {
  if (isWindows) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$pos = [System.Windows.Forms.Cursor]::Position
Write-Output "$($pos.X),$($pos.Y)"
`
    const out = runPs(ps).trim()
    const [x, y] = out.split(',').map(Number)
    return { x, y }
  }

  if (isMac) {
    requireCliclick()
    const out = runCli('cliclick p').trim()
    // cliclick p outputs: "x,y"
    const [x, y] = out.split(',').map(Number)
    return { x, y }
  }

  if (isLinux) {
    const out = runCli('xdotool getmouselocation').trim()
    // output: "x:123 y:456 screen:0 window:..."
    const xm = out.match(/x:(\d+)/)
    const ym = out.match(/y:(\d+)/)
    if (!xm || !ym) throw new Error('Could not parse cursor position from xdotool output')
    return { x: parseInt(xm[1]), y: parseInt(ym[1]) }
  }

  throw new Error(`Unsupported platform: ${os.platform()}`)
}

module.exports = { click, move, type, key, shortcut, drag, cursorPosition }
