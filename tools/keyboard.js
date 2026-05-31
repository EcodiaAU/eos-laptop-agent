const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'

function runAHK(script, timeout) {
  timeout = timeout || 10000
  const tmp = path.join(os.tmpdir(), 'ahk_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.ahk')
  fs.writeFileSync(tmp, '#Requires AutoHotkey v2.0\n' + script + '\nExitApp(0)', 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: timeout, encoding: 'utf8', windowsHide: true, creationFlags: 0x08000000 /* CREATE_NO_WINDOW */ })
    if (r.error) throw r.error
    return { exitCode: r.status }
  } finally {
    try { fs.unlinkSync(tmp) } catch(e) {}
  }
}

// Type text literally - no special key interpretation
async function type(p) {
  const text = p.text || ''
  // Escape backtick and double-quote for AHK v2 string
  const safe = text.replace(/`/g, '``').replace(/"/g, '`"')
  runAHK('SendText "' + safe + '"')
  return { typed: true, length: text.length }
}

// Press a key or combo. Examples: "Enter", "Tab", "ctrl+c", "alt+F4", "ctrl+shift+i"
async function press(p) {
  const key = p.key || ''
  const ahkKey = key
    .replace(/ctrl\+/gi, '^')
    .replace(/alt\+/gi, '!')
    .replace(/shift\+/gi, '+')
    .replace(/win\+/gi, '#')
    .replace(/\benter\b/gi, '{Enter}')
    .replace(/\btab\b/gi, '{Tab}')
    .replace(/\besc(ape)?\b/gi, '{Escape}')
    .replace(/\bdelete\b|\bdel\b/gi, '{Delete}')
    .replace(/\bbackspace\b/gi, '{Backspace}')
    .replace(/\bspace\b/gi, '{Space}')
    .replace(/\b(up|down|left|right)\b/gi, '{$1}')
    .replace(/\bf(\d+)\b/gi, '{F$1}')
  runAHK('Send "' + ahkKey + '"')
  return { pressed: true, key: key, ahkKey: ahkKey }
}

// Bring a window to front by partial title
async function focusWindow(p) {
  const title = p.title || ''
  let script = 'WinActivate "' + title + '"\nWinWaitActive "' + title + '",, 5'
  runAHK(script)
  return { focused: true, title: title }
}

async function copy() {
  runAHK('Send "^c"')
  return { sent: 'ctrl+c' }
}

async function paste() {
  runAHK('Send "^v"')
  return { sent: 'ctrl+v' }
}

module.exports = { type, press, focusWindow, copy, paste }