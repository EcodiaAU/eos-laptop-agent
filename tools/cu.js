// tools/cu.js
// Computer-use executor for Anthropic computer-use beta (computer_20251124).
// Exposes the five primitives the conductor's agent loop dispatches:
//   cu.screenshot, cu.click, cu.type, cu.key, cu.scroll.
//
// Each primitive is a thin wrapper around the existing actuators
// (screenshot.*, input.*, mouse.*). NO loop logic lives here — the
// conductor on ecodiaos-backend owns the messages.create loop.
//
// Per spec: ~/ecodiaos/drafts/macro-pivot-to-computer-use-2026-04-29.md §3.1.
// Per doctrine: ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md.
// Per reload rule: pm2 restart eos-laptop-agent after every edit (require-cache).

const screenshotMod = require('./screenshot')
const inputMod = require('./input')
const mouseMod = require('./mouse')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'
const MOD_KEY_MAP = { ctrl: 'Control', alt: 'Alt', shift: 'Shift', super: 'LWin', cmd: 'LWin', win: 'LWin' }

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function _runAhk(script, timeoutMs = 5000) {
  const tmp = path.join(os.tmpdir(), 'cu-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ahk')
  fs.writeFileSync(tmp, '#Requires AutoHotkey v2.0\n' + script + '\nExitApp(0)', 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true })
    if (r.error) throw r.error
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

async function _holdMod(modifier, down) {
  const k = MOD_KEY_MAP[String(modifier).toLowerCase()] || modifier
  const action = down ? 'Down' : 'Up'
  _runAhk('Send "{' + k + ' ' + action + '}"', 4000)
}

// -------------------------------------------------------------------------
// cu.screenshot
// -------------------------------------------------------------------------
async function screenshot(_params = {}) {
  const r = await screenshotMod.screenshot({})
  if (r && r.error) throw new Error('cu.screenshot: ' + r.error)
  // On Opus 4.7 / computer-use-2025-11-24, long edge cap is 2576px.
  // Corazon's primary display (typically 1920x1080) fits 1:1 — no scaling needed.
  return {
    image: r.image,
    format: r.format || 'png',
    width: r.width,
    height: r.height,
  }
}

// -------------------------------------------------------------------------
// cu.click
//   { x, y, button?='left', modifiers?=[], count?=1 }
//   modifiers: array of 'ctrl'|'alt'|'shift'|'super' (or 'cmd'|'win').
//   count: 1 (single), 2 (double), 3+ (repeated single clicks).
// -------------------------------------------------------------------------
async function click({ x, y, button = 'left', modifiers = [], count = 1 } = {}) {
  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new Error('cu.click: x and y are required numbers')
  }
  const mods = Array.isArray(modifiers) ? modifiers : (modifiers ? [modifiers] : [])
  const c = Math.max(1, parseInt(count, 10) || 1)

  for (const m of mods) await _holdMod(m, true)
  try {
    if (c === 2) {
      await inputMod.click({ x, y, button, double: true })
    } else {
      for (let i = 0; i < c; i++) {
        await inputMod.click({ x, y, button })
        if (i < c - 1) await _sleep(50)
      }
    }
  } finally {
    for (const m of [...mods].reverse()) await _holdMod(m, false)
  }
  return { ok: true, x, y, button, modifiers: mods, count: c }
}

// -------------------------------------------------------------------------
// cu.type — literal text typing.
// -------------------------------------------------------------------------
async function type({ text, delay = 12 } = {}) {
  if (typeof text !== 'string') throw new Error('cu.type: text required (string)')
  return await inputMod.type({ text, delay })
}

// -------------------------------------------------------------------------
// cu.key
//   { key } where key is 'enter'|'f5'|'ctrl+l'|'shift+ctrl+p' etc.
//   Combos go through input.shortcut; single keys through input.key.
// -------------------------------------------------------------------------
async function key({ key: keyName } = {}) {
  if (!keyName || typeof keyName !== 'string') throw new Error('cu.key: key required (string)')
  if (keyName.includes('+')) {
    return await inputMod.shortcut({ keys: keyName })
  }
  return await inputMod.key({ key: keyName, modifiers: [] })
}

// -------------------------------------------------------------------------
// cu.scroll
//   { x, y, direction='down', amount=3, modifiers?=[] }
//   direction: up|down|left|right. up/down use mouse.scroll (AHK WheelUp/WheelDown).
//   left/right use direct AHK WheelLeft/WheelRight.
// -------------------------------------------------------------------------
async function scroll({ x, y, direction = 'down', amount = 3, modifiers = [] } = {}) {
  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new Error('cu.scroll: x and y are required numbers')
  }
  const dir = String(direction).toLowerCase()
  if (!['up', 'down', 'left', 'right'].includes(dir)) {
    throw new Error('cu.scroll: direction must be up|down|left|right')
  }
  const amt = Math.max(1, parseInt(amount, 10) || 3)
  const mods = Array.isArray(modifiers) ? modifiers : (modifiers ? [modifiers] : [])

  for (const m of mods) await _holdMod(m, true)
  try {
    if (dir === 'up' || dir === 'down') {
      await mouseMod.scroll({ x, y, direction: dir, amount: amt })
    } else {
      const wheelDir = dir === 'left' ? 'WheelLeft' : 'WheelRight'
      _runAhk('MouseMove ' + x + ', ' + y + '\nSend "{' + wheelDir + ' ' + amt + '}"', 5000)
    }
  } finally {
    for (const m of [...mods].reverse()) await _holdMod(m, false)
  }
  return { ok: true, x, y, direction: dir, amount: amt, modifiers: mods }
}

module.exports = { screenshot, click, type, key, scroll }
