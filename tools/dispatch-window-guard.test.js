// dispatch-window-guard.test.js - run: node tools/dispatch-window-guard.test.js
//
// Never texts anyone: the sender is swapped for a recorder and TEXT_TATE_PATH
// points at a path that does not exist. The ide registry is a fake file under a
// temp HOME, with live pids (this process and its parent) so ide.listInstances
// keeps them.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dwg-test-'))
process.env.HOME = TMP
process.env.COORD_ROOT = path.join(TMP, '.ecodiaos', 'coordination')
process.env.EOS_IDE_PREFERRED_WORKSPACE = '/Users/ecodia/.code/ecodiaos'
process.env.TEXT_TATE_PATH = path.join(TMP, 'no-such-text-tate.js')
delete process.env.EOS_DISPATCH_WINDOW_GUARD_STATE

const REG_DIR = path.join(TMP, '.ecodia-preview')
fs.mkdirSync(REG_DIR, { recursive: true })
function writeRegistry(entries) {
  const reg = {}
  for (const e of entries) reg[String(e.pid)] = { port: e.port, ide: 'Visual Studio Code', workspaceRoots: e.roots, startedAt: e.startedAt }
  fs.writeFileSync(path.join(REG_DIR, 'instances.json'), JSON.stringify(reg))
}
const PID_A = process.pid
const PID_B = process.ppid
const ROOTED = { pid: PID_A, port: 7458, roots: ['/Users/ecodia/.code/ecodiaos/backend'], startedAt: '2026-10-30T15:00:56.684Z' }
const BLIND = { pid: PID_B, port: 7457, roots: [], startedAt: '2026-10-30T11:32:12.021Z' }

const guard = require('./dispatch-window-guard')
const STATE = path.join(process.env.COORD_ROOT, 'dispatch-window-guard.json')

let pass = 0, fail = 0
const results = []
async function ok(name, fn) {
  try { await fn(); pass++; results.push('PASS ' + name) } catch (e) { fail++; results.push('FAIL ' + name + ': ' + (e && e.stack || e)) }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed') }

const errLines = []
guard._setStderr({ write: (s) => { errLines.push(String(s)) } })
let sends = []
let nextExit = 0
guard._setSender((script, args, done) => { sends.push({ script, args }); setImmediate(() => done(null, nextExit)) })
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)))
function reset() { sends = []; errLines.length = 0; nextExit = 0; try { fs.unlinkSync(STATE) } catch (_e) {} }

;(async () => {
  // ---- 1. returnGate -----------------------------------------------------
  await ok('gate: no result presses (activate_app threw or non-VS Code)', () => {
    assert(guard.returnGate(null).press === true)
    assert(guard.returnGate({ ok: true }).press === true)
  })
  await ok('gate: single window presses, behaviour unchanged', () => {
    const g = guard.returnGate({ ok: true, ide_window: { ok: true, skipped: 'single_window' } })
    assert(g.press === true && g.step === null)
  })
  await ok('gate: bridged window in front presses', () => {
    assert(guard.returnGate({ ide_window: { ok: true, front_is_bridged_window: true, port: 7458 } }).press === true)
  })
  await ok('gate: front_is_bridged_window false skips with the named step', () => {
    const g = guard.returnGate({ ide_window: { ok: false, front_is_bridged_window: false, raised_folder: 'backend' } })
    assert(g.press === false && g.step === 'front_window_not_bridged', JSON.stringify(g))
  })
  await ok('gate: ide_window.ok false (window_match_0, axraise failed, threw) skips', () => {
    for (const reason of ['window_match_0 for folder backend', 'axraise_failed: x', 'threw: boom', 'picked_window_has_no_folder']) {
      const g = guard.returnGate({ ide_window: { ok: false, reason } })
      assert(g.press === false && g.reason === reason, reason + ' -> ' + JSON.stringify(g))
    }
  })

  // ---- 2. checkBridgeWindowFolder through the REAL ide.pickInstance -------
  await ok('guard: two windows, rooted one picked, silent', async () => {
    reset(); writeRegistry([ROOTED, BLIND])
    const r = guard.checkBridgeWindowFolder()
    await flush()
    assert(r.rooted === true && r.port === 7458, JSON.stringify(r))
    assert(sends.length === 0 && errLines.length === 0)
  })
  await ok('guard: single rooted window, silent', async () => {
    reset(); writeRegistry([ROOTED])
    const r = guard.checkBridgeWindowFolder()
    assert(r.rooted === true && sends.length === 0)
  })
  await ok('guard: only the folderless window left, stderr + one text, never blocks', async () => {
    reset(); writeRegistry([BLIND])
    const r = guard.checkBridgeWindowFolder({ now: Date.parse('2026-10-31T00:00:00Z') })
    assert(r.rooted === false && r.texted === true && r.port === 7457, JSON.stringify(r))
    assert(errLines.some((l) => /BLIND DISPATCH WINDOW/.test(l) && /port 7457/.test(l)), errLines.join(''))
    assert(sends.length === 1)
    const a = sends[0].args
    assert(a[0] === '--from' && a[1] === 'dispatch-window-guard' && a[2] === '--urgency' && a[3] === 'critical', JSON.stringify(a))
    assert(sends[0].script === process.env.TEXT_TATE_PATH)
    assert(!/—/.test(a[4]), 'message must carry no em dash')
    await flush()
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    assert(s.latched_at && s.last_sent_at && s.last_exit === 0, JSON.stringify(s))
  })
  await ok('guard: second blind dispatch inside 6h is suppressed, stderr still loud', async () => {
    errLines.length = 0; sends = []
    const r = guard.checkBridgeWindowFolder({ now: Date.parse('2026-10-31T05:59:00Z') })
    assert(r.texted === false && r.suppressed === 'latched_within_6h', JSON.stringify(r))
    assert(sends.length === 0 && errLines.length >= 1)
  })
  await ok('guard: after 6h it texts again', async () => {
    sends = []
    const r = guard.checkBridgeWindowFolder({ now: Date.parse('2026-10-31T06:00:01Z') })
    assert(r.texted === true && sends.length === 1, JSON.stringify(r))
    await flush()
  })
  await ok('guard: a failed send (exit 1) is retried after 15 min, not per dispatch', async () => {
    reset(); writeRegistry([BLIND]); nextExit = 1
    const t0 = Date.parse('2026-11-01T00:00:00Z')
    assert(guard.checkBridgeWindowFolder({ now: t0 }).texted === true)
    await flush()
    let s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    assert(!s.latched_at && !s.last_sent_at && s.last_exit === 1, JSON.stringify(s))
    const r2 = guard.checkBridgeWindowFolder({ now: t0 + 60 * 1000 })
    assert(r2.texted === false && r2.suppressed === 'retry_backoff_after_failed_send', JSON.stringify(r2))
    nextExit = 0
    const r3 = guard.checkBridgeWindowFolder({ now: t0 + guard.RETRY_AFTER_FAILURE_MS + 1 })
    assert(r3.texted === true && sends.length === 2, JSON.stringify(r3))
    await flush()
  })
  await ok('guard: two dispatches inside one in-flight send cannot both text', async () => {
    reset(); writeRegistry([BLIND])
    let held = null
    guard._setSender((script, args, done) => { sends.push({ args }); held = done })
    const t0 = Date.parse('2026-11-02T00:00:00Z')
    guard.checkBridgeWindowFolder({ now: t0 })
    const r2 = guard.checkBridgeWindowFolder({ now: t0 + 1000 })
    assert(sends.length === 1 && r2.texted === false, JSON.stringify(r2))
    held(null, 0); await flush()
    guard._setSender((script, args, done) => { sends.push({ script, args }); setImmediate(() => done(null, nextExit)) })
  })
  await ok('guard: a send-gate refusal (exit 3) holds the 6h latch but records no send', async () => {
    reset(); writeRegistry([BLIND]); nextExit = 3
    guard.checkBridgeWindowFolder({ now: Date.parse('2026-11-03T00:00:00Z') })
    await flush()
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    assert(s.latched_at && !s.last_sent_at && s.last_exit === 3, JSON.stringify(s))
  })
  await ok('guard: two folderless windows (pick throws) adds nothing to the loud send failure', async () => {
    reset(); writeRegistry([BLIND, { pid: PID_A, port: 7459, roots: [], startedAt: '2026-10-30T12:00:00Z' }])
    const r = guard.checkBridgeWindowFolder()
    assert(r.checked === false && /ambiguous/.test(r.reason) && sends.length === 0, JSON.stringify(r))
  })
  await ok('guard: setters refuse JSON-shaped input from the tool API', async () => {
    guard._setSender({ script: '/bin/sh' })
    guard._setIde({ _pickInstance: 'x' })
    reset(); writeRegistry([ROOTED])
    // A JSON sender reset the seam to the real default: prove it by NOT reaching it
    // (rooted window, no send), then restore the recorder.
    assert(guard.checkBridgeWindowFolder().rooted === true)
    guard._setSender((script, args, done) => { sends.push({ script, args }); setImmediate(() => done(null, nextExit)) })
  })

  // ---- 3. the dispatcher wiring ----------------------------------------
  const dispSrcPath = path.join(__dirname, 'mac-dispatcher.js')
  const dispSrc = fs.readFileSync(dispSrcPath, 'utf8')
  await ok('dispatcher: guard runs before every chat_send_message', () => {
    const sendAt = dispSrc.indexOf('await ide.chat_send_message(')
    const guardAt = dispSrc.lastIndexOf('dispatchWindowGuard.checkBridgeWindowFolder()', sendAt)
    assert(sendAt > 0 && guardAt > 0 && sendAt - guardAt < 400, 'guard=' + guardAt + ' send=' + sendAt)
    assert(dispSrc.split('await ide.chat_send_message(').length === 2, 'exactly one send call site expected')
  })
  await ok('dispatcher: every activate_app before a Return goes through returnGate', () => {
    const acts = dispSrc.split("applescript.activate_app({ app: 'Visual Studio Code' })").length - 1
    const gates = dispSrc.split('dispatchWindowGuard.returnGate(').length - 1
    assert(acts >= 1 && gates === acts, 'activate_app=' + acts + ' returnGate=' + gates)
  })

  // _runSubmitChain exists only in the uncommitted refactor of mac-dispatcher.js.
  // When it is present, drive it for real with applescript and ide stubbed.
  if (/async function _runSubmitChain\(/.test(dispSrc)) {
    const m = new Module(dispSrcPath, module)
    m.filename = dispSrcPath
    m.paths = Module._nodeModulePaths(__dirname)
    m._compile(dispSrc + '\nmodule.exports.__runSubmitChain = _runSubmitChain\n', dispSrcPath)
    const run = m.exports.__runSubmitChain
    const applescript = require('./applescript')
    const ide = require('./ide')
    const realAct = applescript.activate_app, realKey = applescript.keystroke, realCmd = ide.command
    let keys = 0
    ide.command = async () => ({ ok: true })
    applescript.keystroke = async () => { keys++; return { ok: true } }
    const drive = async (actImpl) => {
      keys = 0
      applescript.activate_app = actImpl
      return run({ viewColumn: 1, tabIndex: 0 }, 'tab_test', 1)
    }
    try {
      await ok('chain: single window presses Return once', async () => {
        const r = await drive(async () => ({ ok: true, ide_window: { ok: true, skipped: 'single_window' } }))
        assert(keys === 1 && r.keystroke_ok === true && r.steps.includes('return_keystroke'), JSON.stringify(r))
      })
      await ok('chain: bridged window not in front skips Return, does not abort, loop retries', async () => {
        const r = await drive(async () => ({ ok: true, ide_window: { ok: false, front_is_bridged_window: false } }))
        assert(keys === 0, 'Return pressed ' + keys + 'x')
        assert(r.ok === true && !r.aborted && r.keystroke_ok === false && r.return_skipped === 'front_window_not_bridged', JSON.stringify(r))
        assert(r.steps.includes('front_window_not_bridged') && !r.steps.includes('return_keystroke'))
      })
      await ok('chain: bridged window in front presses', async () => {
        const r = await drive(async () => ({ ok: true, ide_window: { ok: true, front_is_bridged_window: true } }))
        assert(keys === 1 && r.keystroke_ok === true, JSON.stringify(r))
      })
      await ok('chain: activate_app throwing keeps the old press-anyway behaviour', async () => {
        const r = await drive(async () => { throw new Error('osascript down') })
        assert(keys === 1 && r.steps.includes('activate_app_failed'), JSON.stringify(r))
      })
    } finally {
      applescript.activate_app = realAct; applescript.keystroke = realKey; ide.command = realCmd
    }
  } else {
    results.push('SKIP chain: _runSubmitChain not in this mac-dispatcher.js (HEAD shape; the source checks above cover it)')
  }

  for (const r of results) console.log(r)
  console.log(pass + ' passed, ' + fail + ' failed')
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_e) {}
  process.exit(fail ? 1 : 0)
})()
