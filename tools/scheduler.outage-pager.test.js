// scheduler.outage-pager.test.js - bare-Node unit test for the dispatch-outage
// pager (2026-08-13 survival hardening). Asserts the transient-IDE-bridge defer
// counter fires EXACTLY ONE page at the threshold, latches (no spam), and resets
// on a successful dispatch so a fresh outage pages again. The real send is
// stubbed via _setPagerSender: this test NEVER texts Tate.
//
// Run: node tools/scheduler.outage-pager.test.js   (exit 0 = pass, non-zero = fail)
'use strict'

const assert = require('assert')
const scheduler = require('./scheduler')

let failures = 0
function ok(name, fn) {
  try { fn(); console.log('  ok - ' + name) }
  catch (e) { failures++; console.error('  FAIL - ' + name + ': ' + (e && e.message || e)) }
}

// Recorder sender: captures every constructed (scriptPath, args) instead of
// spawning text-tate.js.
const sent = []
scheduler._setPagerSender((scriptPath, args) => { sent.push({ scriptPath, args }) })

function reset() { sent.length = 0; scheduler._resetOutageState() }

// ── 1. no page before the threshold ──────────────────────────────────────────
ok('below threshold: no page', () => {
  reset()
  const r1 = scheduler.noteTransientDefer('no IDE instances registered')
  const r2 = scheduler.noteTransientDefer('populate failed (editor.open): socket hang up')
  assert.strictEqual(r1, null, 'defer 1 must not page')
  assert.strictEqual(r2, null, 'defer 2 must not page')
  assert.strictEqual(sent.length, 0, 'no send before threshold (default 3)')
  assert.strictEqual(scheduler._getOutageState().consecutive, 2)
  assert.strictEqual(scheduler._getOutageState().sent, false)
})

// ── 2. exactly one page AT the threshold, then latched ────────────────────────
ok('threshold: exactly one page, then latched (no spam)', () => {
  reset()
  let fired = null
  for (let i = 0; i < 3; i++) {
    const r = scheduler.noteTransientDefer('ECONNREFUSED')
    if (r) fired = r
  }
  assert.strictEqual(sent.length, 1, 'exactly ONE send at threshold')
  assert.ok(fired, 'the 3rd defer returns the constructed command')
  assert.strictEqual(scheduler._getOutageState().sent, true, 'latched after page')

  // Ten more defers during the SAME outage: still exactly one page total.
  for (let i = 0; i < 10; i++) scheduler.noteTransientDefer('ETIMEDOUT')
  assert.strictEqual(sent.length, 1, 'no further sends while latched (rate-limited to one per outage)')
})

// ── 3. constructed command shape is correct + em-dash free ────────────────────
ok('constructed command targets text-tate.js with --from watchdog label', () => {
  reset()
  let fired = null
  for (let i = 0; i < 3; i++) { const r = scheduler.noteTransientDefer('socket hang up'); if (r) fired = r }
  assert.ok(fired, 'page fired')
  const rec = sent[0]
  assert.ok(/imessage-agent\/text-tate\.js$/.test(rec.scriptPath), 'script path is text-tate.js: ' + rec.scriptPath)
  assert.strictEqual(rec.args[0], '--from')
  assert.strictEqual(rec.args[1], 'scheduler watchdog')
  const msg = rec.args[2]
  assert.ok(/DISPATCH OUTAGE/.test(msg), 'message names the outage')
  assert.ok(/STALLED/.test(msg), 'message says work is stalled')
  // The whole constructed command must be em-dash (U+2014) free.
  const EMDASH = String.fromCharCode(0x2014)
  assert.ok(!fired.command.includes(EMDASH), 'command must contain no em-dash')
  assert.ok(!msg.includes(EMDASH), 'message must contain no em-dash')
})

// ── 4. counter resets on a successful dispatch ────────────────────────────────
ok('successful dispatch resets the counter and latch', () => {
  reset()
  scheduler.noteTransientDefer('ECONNRESET')
  scheduler.noteTransientDefer('ECONNRESET')
  assert.strictEqual(scheduler._getOutageState().consecutive, 2)
  scheduler.noteSuccessfulDispatch()
  assert.strictEqual(scheduler._getOutageState().consecutive, 0, 'counter reset to 0 on success')
  assert.strictEqual(scheduler._getOutageState().sent, false, 'latch cleared on success')
})

// ── 5. a fresh outage AFTER recovery pages again (not permanently muted) ───────
ok('fresh outage after recovery pages again', () => {
  reset()
  // First outage: page.
  for (let i = 0; i < 3; i++) scheduler.noteTransientDefer('no IDE instances registered')
  assert.strictEqual(sent.length, 1, 'first outage paged once')
  // Recovery.
  scheduler.noteSuccessfulDispatch()
  // Second outage: must page again.
  for (let i = 0; i < 3; i++) scheduler.noteTransientDefer('no IDE instances registered')
  assert.strictEqual(sent.length, 2, 'second outage pages again after recovery')
})

// ── 6. a single defer then recovery never pages (transient blip, not outage) ──
ok('single transient blip then recovery never pages', () => {
  reset()
  scheduler.noteTransientDefer('socket hang up')
  scheduler.noteSuccessfulDispatch()
  scheduler.noteTransientDefer('socket hang up')
  scheduler.noteSuccessfulDispatch()
  assert.strictEqual(sent.length, 0, 'isolated blips separated by success never reach the threshold')
})

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
