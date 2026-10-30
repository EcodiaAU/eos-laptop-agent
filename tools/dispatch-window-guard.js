// dispatch-window-guard.js - two checks on the Mac dispatch path that keep a
// worker tab from being submitted into the wrong VS Code window, or opening blind.
//
// Board b2afd838 / d3c6e7cd, 2026-10-31. Doctrine:
// backend/patterns/a-claude-code-tab-takes-its-cwd-from-its-windows-first-folder-2026-10-31.md
//
// 1. returnGate(activateRes). applescript.activate_app('Visual Studio Code')
//    AXRaises the window the ide bridge answers from and reads back the front
//    window. The submit is one System Events Return, which goes to the KEY
//    window. With two windows open, a Return pressed while the other window is
//    in front lands in that window's focused chat. So when activate_app reports
//    the bridged window is not in front, the dispatcher skips the Return for that
//    attempt and lets its own retry/abandon path decide. One window (skipped) and
//    any result without an ide_window block press exactly as before.
//
// 2. checkBridgeWindowFolder(). A Claude Code tab takes its cwd from its window's
//    first folder, or the home folder when the window has none. If the rooted
//    window closes or its extension host restarts, ide.pickInstance falls back to
//    the folderless window alone, every worker opens in /Users/ecodia with no
//    project MCP config, and nothing in dispatch notices: activate_app returns
//    skipped:'single_window' and the submit goes through. That is how the defect
//    hid until scheduler-health paged. This check runs just before
//    ide.chat_send_message, writes one loud stderr line, and texts Tate at most
//    once per 6h. It never blocks the dispatch.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const TEXT_INTERVAL_MS = 6 * 60 * 60 * 1000
// A send that did not exit 0 (transport failure, timeout) is retried, but no
// sooner than this, so a broken send path costs one spawn per 15 min rather than
// one per dispatch.
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000
const SEND_TIMEOUT_MS = 30000
const FROM_LABEL = 'dispatch-window-guard'

function _coordRoot() {
  return process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')
}
function _statePath() {
  return process.env.EOS_DISPATCH_WINDOW_GUARD_STATE || path.join(_coordRoot(), 'dispatch-window-guard.json')
}
function _textTatePath() {
  return process.env.TEXT_TATE_PATH
    || path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'imessage-agent', 'text-tate.js')
}

// ---------------------------------------------------------------------------
// 1. The Return gate.
// ---------------------------------------------------------------------------
function returnGate(activateRes) {
  const w = activateRes && activateRes.ide_window
  if (!w) return { press: true, step: null, reason: 'no_ide_window_result' }
  if (w.skipped) return { press: true, step: null, reason: 'single_window' }
  if (w.ok === false || w.front_is_bridged_window === false) {
    return {
      press: false,
      step: 'front_window_not_bridged',
      reason: String(w.reason || ('front_is_bridged_window=' + w.front_is_bridged_window)).slice(0, 200),
    }
  }
  return { press: true, step: null, reason: 'bridged_window_in_front' }
}

// ---------------------------------------------------------------------------
// 2. The no-folder alarm.
// ---------------------------------------------------------------------------
function _readState(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || {} } catch (_e) { return {} }
}
function _writeState(p, s) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = p + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    return true
  } catch (_e) { return false }
}

// Default sender: spawn text-tate.js on THIS process's node (the agent's own
// binary, the same one the scheduler pagers use), args array and no shell, with
// a watchdog. Async on purpose: the dispatch never waits on the text.
function _defaultSend(scriptPath, args, done) {
  let settled = false
  const finish = (err, code) => {
    if (settled) return
    settled = true
    try { done(err, code) } catch (_e) {}
  }
  try {
    const child = require('child_process').spawn(process.execPath, [scriptPath, ...args], { stdio: 'ignore' })
    const watchdog = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (_e) {}
      finish(new Error('send timed out after ' + SEND_TIMEOUT_MS + 'ms'), null)
    }, SEND_TIMEOUT_MS)
    if (watchdog.unref) watchdog.unref()
    child.on('error', (e) => { clearTimeout(watchdog); finish(e, null) })
    child.on('exit', (code) => { clearTimeout(watchdog); finish(null, code) })
  } catch (e) { finish(e, null) }
}

function _message(inst) {
  return 'Dispatch bridge VS Code window (pid ' + inst.pid + ', port ' + inst.port + ') has no folder,'
    + ' so new worker tabs open in the home folder with no coord tools and cannot bind.'
    + ' Fix: open a backend-rooted window (code -n ' + path.join(os.homedir(), '.code', 'ecodiaos', 'backend')
    + ' from a clean shell).'
    + ' Do not re-root or reload the open window.'
}

// Test seams. lib/tool-autoload exposes every export of this file over the agent's
// HTTP tool API, so nothing a JSON caller can pass may choose a path to write or a
// script to spawn. Paths come from env only; the sender, stderr and ide resolver are
// swapped through setters that accept nothing but the right shape.
let _send = _defaultSend
let _stderr = process.stderr
let _ideOverride = null
function _setSender(fn) { if (typeof fn === 'function') _send = fn; else _send = _defaultSend; return { ok: true } }
function _setStderr(st) { _stderr = (st && typeof st.write === 'function') ? st : process.stderr; return { ok: true } }
function _setIde(mod) { _ideOverride = (mod && typeof mod._pickInstance === 'function') ? mod : null; return { ok: true } }

// opts: { now } (a number, tests only). Anything else is ignored.
function checkBridgeWindowFolder(opts) {
  opts = opts || {}
  const ide = _ideOverride || require('./ide')
  const stderr = _stderr
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  let inst
  try {
    inst = ide._pickInstance({})
  } catch (e) {
    // chat_send_message calls the same resolver and will throw the same way;
    // that failure is already loud, so this check adds nothing to it.
    return { ok: true, checked: false, reason: 'pick_threw: ' + String(e && e.message || e).slice(0, 160) }
  }
  const roots = (inst && inst.workspaceRoots) || []
  if (roots.length > 0) return { ok: true, checked: true, rooted: true, pid: inst.pid, port: inst.port }

  stderr.write('[dispatch-window-guard] BLIND DISPATCH WINDOW: the ide bridge instance chat_send_message'
    + ' will use (pid ' + inst.pid + ', port ' + inst.port + ') has workspaceRoots []. This worker tab'
    + ' opens home-rooted with no project MCP config and cannot signal_bound. Open a backend-rooted'
    + ' window; never re-root the live one.\n')

  const statePath = _statePath()
  const state = _readState(statePath)
  const lastOk = Date.parse(state.latched_at || '') || 0
  const lastTry = Date.parse(state.last_attempt_at || '') || 0
  if (lastOk && now - lastOk < TEXT_INTERVAL_MS) {
    return { ok: true, checked: true, rooted: false, pid: inst.pid, port: inst.port, texted: false,
      suppressed: 'latched_within_6h', next_text_after: new Date(lastOk + TEXT_INTERVAL_MS).toISOString() }
  }
  if (lastTry && lastTry > lastOk && now - lastTry < RETRY_AFTER_FAILURE_MS) {
    return { ok: true, checked: true, rooted: false, pid: inst.pid, port: inst.port, texted: false,
      suppressed: 'retry_backoff_after_failed_send' }
  }

  // Claim the slot BEFORE sending, so two dispatches inside one send cannot
  // both text. latched_at (the 6h clock) is set on exit 0 or a gate refusal;
  // last_sent_at only on exit 0, so the file never claims a text that did not go.
  const attemptAt = new Date(now).toISOString()
  _writeState(statePath, Object.assign({}, state, {
    last_attempt_at: attemptAt, last_attempt_pid: inst.pid, last_attempt_port: inst.port, last_exit: null,
  }))
  const args = ['--from', FROM_LABEL, '--urgency', 'critical', _message(inst)]
  _send(_textTatePath(), args, (err, code) => {
    const s = _readState(statePath)
    s.last_exit = code
    s.last_error = err ? String(err.message || err).slice(0, 200) : null
    // Exit 3 is a send-gate policy refusal: retrying will not change the answer,
    // so it holds the 6h latch like a success instead of re-spawning every 15 min.
    if (!err && (code === 0 || code === 3)) s.latched_at = attemptAt
    if (!err && code === 0) s.last_sent_at = attemptAt
    _writeState(statePath, s)
    stderr.write('[dispatch-window-guard] text to Tate ' + (code === 0 ? 'sent' : 'NOT sent')
      + ' (exit ' + code + (err ? ', ' + s.last_error : '') + ')\n')
  })
  return { ok: true, checked: true, rooted: false, pid: inst.pid, port: inst.port, texted: true, args }
}

module.exports = {
  returnGate,
  checkBridgeWindowFolder,
  TEXT_INTERVAL_MS,
  RETRY_AFTER_FAILURE_MS,
  _message,
  _setSender,
  _setStderr,
  _setIde,
}
