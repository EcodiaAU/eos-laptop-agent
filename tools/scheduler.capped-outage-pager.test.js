// scheduler.capped-outage-pager.test.js - bare-Node unit test for the
// all-accounts-capped outage signal (2026-08-29 lane D1).
//
// Why this file exists. When every Anthropic account is capped, dispatchOne's
// AllAccountsCappedError branch deferred the row and returned: no page, no
// stderr, and no touch of retry_count. Three mechanisms exist to notice that
// dispatch has stopped and all three missed it. Measured on the live log,
// 24.5MB across the agent's whole lifetime: 36 AllAccountsCapped diag lines,
// 2,311 "breaker: recorded dispatch" lines, and ZERO "OUTAGE PAGE" lines.
//
// Two halves are under test here.
//   1. The defer WRITES retry_count, bounded at CAPPED_RETRY_MARK, so
//      scheduler-health.sh's capped_churn detector (retry_count >= 2 AND
//      last_error ILIKE AllAccountsCappedError) can match at all.
//   2. A capped outage pages Tate exactly once, with its OWN latch and its OWN
//      message. It must NOT reuse the transient-bridge text, which says
//      "Reopen VSCode" and is the wrong diagnosis for an account outage.
//
// And the guard that keeps half 1 from breaking the failure budget: retry_count
// carries a second meaning (MAX_RETRY_COUNT permanently fails a one-shot row),
// so markFailed must not inherit a count that is only a cap marker.
//
// Every send is stubbed via _setPagerSender and every query via _setPool: this
// test NEVER texts Tate and NEVER touches Postgres.
//
// Run: node tools/scheduler.capped-outage-pager.test.js   (exit 0 = pass)
'use strict'

const assert = require('assert')
const scheduler = require('./scheduler')

let failures = 0
async function ok(name, fn) {
  try { await fn(); console.log('  ok - ' + name) }
  catch (e) { failures++; console.error('  FAIL - ' + name + ': ' + (e && e.message || e)) }
}

const sent = []
const queries = []

// pruneWorktreeForRow shells out to git; markFailed calls it before any branch.
scheduler.pruneWorktreeForRow = async () => {}

// Every stub is (re)installed in reset(), never once at module scope. A test that
// installs a FAILING stub and then throws its assertion never reaches a restore
// line at the end of its own body, so a module-scope install leaks that failure
// into every later test and reports four bugs that are one harness mistake.
function reset() {
  sent.length = 0
  queries.length = 0
  scheduler._resetCappedOutageState()
  scheduler._setPagerSender((scriptPath, args, done) => {
    sent.push({ scriptPath, args })
    if (done) done(null, 0)
  })
  // Recording pool stub: captures every (sql, params) and reports one row matched
  // so the suspended-signal fallback never fires.
  scheduler._setPool({ query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1, rows: [] } } })
}

const T0 = 1756000000000            // fixed clock, no Date.now in assertions
const MIN = 60 * 1000
const cappedErr = (resets) => {
  const e = new Error('all enabled accounts are capped')
  e.name = 'AllAccountsCappedError'
  if (resets) e.resets = resets
  return e
}
const row = (over) => Object.assign({ id: 'aaaaaaaa-0000-4000-8000-000000000001', type: 'one_shot', retry_count: 0 }, over || {})

;(async () => {
console.log('scheduler.capped-outage-pager.test.js')

// 1. The defer writes retry_count, bounded at the detector threshold ----------
await ok('capped defer INCREMENTS retry_count (the detector counts it)', async () => {
  reset()
  await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0)
  assert.strictEqual(queries.length, 1, 'exactly one UPDATE')
  const q = queries[0]
  assert.ok(/retry_count\s*=/.test(q.sql), 'the defer UPDATE must SET retry_count; it did not: ' + q.sql)
})

await ok('capped defer BOUNDS retry_count at the detector threshold, not unbounded', async () => {
  reset()
  await scheduler.handleAllAccountsCappedDefer(row({ retry_count: 9 }), cappedErr(), T0)
  const q = queries[0]
  assert.ok(/LEAST/i.test(q.sql), 'must bound the increment (LEAST), or a cap outage burns the whole failure budget: ' + q.sql)
  assert.ok(q.params.includes(scheduler.CAPPED_RETRY_MARK), 'the bound must be CAPPED_RETRY_MARK, params=' + JSON.stringify(q.params))
  assert.strictEqual(scheduler.CAPPED_RETRY_MARK, 2, 'the bound must equal scheduler-health.sh:103 threshold (retry_count >= 2)')
})

await ok('capped defer still releases the lease and keeps the row active', async () => {
  reset()
  await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0)
  const q = queries[0]
  assert.ok(/status\s*=\s*'active'/.test(q.sql), 'row stays active')
  assert.ok(/leased_by\s*=\s*NULL/.test(q.sql), 'lease released')
  assert.ok(q.params.some(p => String(p).includes('AllAccountsCappedError')), 'last_error keeps the marker the detector greps for')
})

await ok('capped defer honours the reset clock and the 60s floor', async () => {
  reset()
  // A reset 30min out: next_run_at is reset + 60s.
  await scheduler.handleAllAccountsCappedDefer(row(), cappedErr({ 'a@x': new Date(T0 + 30 * MIN).toISOString() }), T0)
  const nextRun = Date.parse(queries[0].params[0])
  assert.strictEqual(nextRun, T0 + 30 * MIN + 60000, 'reset + 60s')
  reset()
  // A reset already in the past: the 60s floor wins (the live shape today).
  await scheduler.handleAllAccountsCappedDefer(row(), cappedErr({ 'a@x': new Date(T0 - 5 * MIN).toISOString() }), T0)
  assert.strictEqual(Date.parse(queries[0].params[0]), T0 + 60000, 'floor at 60s')
})

// 2. The page ----------------------------------------------------------------
await ok('no page before the outage has persisted (a 60s defer is not an outage)', async () => {
  reset()
  for (let i = 0; i < 8; i++) {
    const r = await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0 + i * MIN)
    assert.strictEqual(r, null, 'defer at +' + i + 'min must not page')
  }
  assert.strictEqual(sent.length, 0, 'no send inside the persistence window')
})

await ok('pages EXACTLY ONCE once the outage persists, then latches', async () => {
  reset()
  let fired = null
  for (let i = 0; i <= 12; i++) {
    const r = await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0 + i * MIN)
    if (r) fired = r
  }
  assert.strictEqual(sent.length, 1, 'exactly ONE page for the outage, got ' + sent.length)
  assert.ok(fired, 'the crossing defer returns the constructed page')
  for (let i = 13; i < 200; i++) await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0 + i * MIN)
  assert.strictEqual(sent.length, 1, 'latched: no re-page while the same outage persists')
})

await ok('the page names the ACCOUNT diagnosis, never the IDE one', async () => {
  reset()
  let fired = null
  for (let i = 0; i <= 12; i++) {
    const r = await scheduler.handleAllAccountsCappedDefer(row(), cappedErr({ 'tate@ecodia.au': new Date(T0 + 3 * 3600000).toISOString() }), T0 + i * MIN)
    if (r) fired = r
  }
  assert.ok(fired, 'page fired')
  const msg = fired.message
  assert.ok(/capped/i.test(msg), 'must say capped: ' + msg)
  assert.ok(!/Reopen VSCode/i.test(msg), 'must NOT reuse the transient-bridge remedy (wrong diagnosis): ' + msg)
  assert.ok(!/IDE/i.test(msg), 'must not blame the IDE: ' + msg)
  assert.ok(msg.indexOf('\u2014') === -1, 'no em-dash (U+2014 banned at character level)')
  assert.ok(/account-switch|re-auth|switch/i.test(msg), 'must name the actual remedy: ' + msg)
  assert.strictEqual(sent[0].args[0], '--from', 'text-tate --from label')
})

await ok('a successful dispatch clears the latch so a LATER outage pages afresh', async () => {
  reset()
  for (let i = 0; i <= 12; i++) await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0 + i * MIN)
  assert.strictEqual(sent.length, 1, 'first outage paged')
  scheduler.noteSuccessfulDispatch()
  assert.strictEqual(scheduler._getCappedOutageState().sent, false, 'latch cleared on recovery')
  const base = T0 + 100 * MIN
  for (let i = 0; i <= 12; i++) await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), base + i * MIN)
  assert.strictEqual(sent.length, 2, 'a NEW outage after recovery pages again')
})

await ok('a failed send (non-zero exit) unlatches so the next defer retries', async () => {
  reset()
  let calls = 0
  scheduler._setPagerSender((s, a, done) => { calls++; if (done) done(null, 1) })
  for (let i = 0; i <= 10; i++) await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0 + i * MIN)
  assert.strictEqual(calls, 1, 'one attempt at the threshold, got ' + calls)
  assert.strictEqual(scheduler._getCappedOutageState().sent, false, 'non-zero exit leaves the latch unset')
  await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0 + 11 * MIN)
  assert.strictEqual(calls, 2, 'retried on the next defer')
})

await ok('a pg failure does NOT swallow the page (independent legs)', async () => {
  reset()
  scheduler._setPool({ query: async () => { throw new Error('connection terminated') } })
  let fired = null
  for (let i = 0; i <= 10; i++) {
    const r = await scheduler.handleAllAccountsCappedDefer(row(), cappedErr(), T0 + i * MIN)
    if (r) fired = r
  }
  assert.ok(fired, 'the page fires even when the row write throws')
  assert.strictEqual(sent.length, 1, 'exactly one page despite the pg failure')
  assert.strictEqual(queries.length, 0, 'and the row write genuinely did fail (nothing recorded)')
})

// 3. The failure budget must survive the new write ----------------------------
await ok('markFailed does NOT inherit a cap-marked retry_count as a failure budget', async () => {
  reset()
  // A one-shot row parked at the cap mark by an outage, then hit by one real error.
  await scheduler.markFailed(row({ retry_count: 2, last_error: 'AllAccountsCappedError - deferred 1min' }), new Error('boom'))
  const q = queries[queries.length - 1]
  assert.ok(!/status\s*=\s*'failed'/.test(q.sql),
    'a cap-inflated count must not permanently fail a one-shot row on its FIRST real error: ' + q.sql)
  assert.strictEqual(q.params[0], 1, 'the failure budget restarts at 1, got ' + q.params[0])
})

await ok('markFailed STILL permanently fails on a genuine exhausted budget', async () => {
  reset()
  await scheduler.markFailed(row({ retry_count: 2, last_error: 'editor.open exploded' }), new Error('boom'))
  const q = queries[queries.length - 1]
  assert.ok(/status\s*=\s*'failed'/.test(q.sql), 'a real 3rd failure still fails the row: ' + q.sql)
})

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
})()
