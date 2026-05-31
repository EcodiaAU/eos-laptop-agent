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
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    try { fs.unlinkSync(tmp) } catch(e) {}
  }
}

async function click(p) {
  const x = p.x, y = p.y, n = p.double ? 2 : 1
  runAHK('Click ' + x + ', ' + y + ', ' + n)
  return { clicked: true, x: x, y: y }
}

async function rightClick(p) {
  runAHK('Click "Right", ' + p.x + ', ' + p.y)
  return { clicked: true, x: p.x, y: p.y, button: 'right' }
}

async function doubleClick(p) {
  runAHK('Click ' + p.x + ', ' + p.y + ', 2')
  return { clicked: true, x: p.x, y: p.y, double: true }
}

async function move(p) {
  runAHK('MouseMove ' + p.x + ', ' + p.y)
  return { moved: true, x: p.x, y: p.y }
}

async function scroll(p) {
  // AHK v2 has no {WheelDown N} count syntax; use Click "WheelDown" in a Loop.
  // Previous {WheelDown 3} form parsed as invalid Send key, AHK popped a hidden
  // error dialog (windowsHide:true) and the spawnSync would hang until timeout.
  const dir = (p.direction || 'down') === 'down' ? 'WheelDown' : 'WheelUp'
  const amt = Math.max(1, p.amount || 3)
  const script =
    'MouseMove ' + (p.x | 0) + ', ' + (p.y | 0) + '\n' +
    'Loop ' + amt + ' {\n' +
    '  Click "' + dir + '"\n' +
    '}'
  runAHK(script)
  return { scrolled: true, direction: p.direction || 'down', amount: amt, x: p.x | 0, y: p.y | 0 }
}

async function drag(p) {
  runAHK('MouseClickDrag "Left", ' + p.fromX + ', ' + p.fromY + ', ' + p.toX + ', ' + p.toY)
  return { dragged: true }
}

module.exports = { click, rightClick, doubleClick, move, scroll, drag }