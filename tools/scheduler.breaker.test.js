// scheduler.breaker.test.js - bare-Node unit + integration test for the runaway
// dispatch circuit breaker (Hunter 4 #7, 2026-08-13 survival hardening).
//
// Proves, WITHOUT ever texting Tate and WITHOUT a database:
//   1. The rolling-window aggregate breaker allows dispatch below the cap, FREEZES
//      at the cap, fires EXACTLY ONE page, and stays latched (no spam).
//   2. The freeze auto-clears when the window rolls, and again on the operator reset file.
//   3. The same-name guard leaves a below-threshold name untouched and QUARANTINES a
//      name that loops past the limit within the window (the "5-in-2-min loop"), firing
//      exactly one page per name.
//   4. quarantineRow issues the last_status='paused' UPDATE and never throws on a DB error.
//
// Thresholds are shrunk via env BEFORE require so the trips are deterministic; the real
// send is stubbed via _setPagerSender. All timestamps are injected (nowMs) so nothing
// depends on the wall clock.
//
// Run: node tools/scheduler.breaker.test.js   (exit 0 = pass, non-zero = fail)
'use strict'

process.env.SCHEDULER_BREAKER_MAX_DISPATCHES = '3'         // aggregate freezes on the 4th
process.env.SCHEDULER_BREAKER_WINDOW_MS = '60000'          // 1 min aggregate window
process.env.SCHEDULER_BREAKER_SAMENAME_MAX = '5'           // same-name quarantines on the 6th ("more than 5")
process.env.SCHEDULER_BREAKER_SAMENAME_WINDOW_MS = '120000'// 2 min same-name window
process.env.SCHEDULER_BREAKER_RESET_FILE =
  require('path').join(require('os').tmpdir(), 'eos-breaker-test-RESET-' + process.pid)

const assert = require('assert')
const fs = require('fs')
const scheduler = require('./scheduler')

let failures = 0
const _queue = []
// Register a test; supports both sync and async fns. Executed in order by run().
function ok(name, fn) { _queue.push({ name, fn }) }
async function run() {
  for (const t of _queue) {
    try { await t.fn(); console.log('  ok - ' + t.name) }
    catch (e) { failures++; console.error('  FAIL - ' + t.name + ': ' + (e && e.message || e)) }
  }
  if (failures) { console.error('\n' + failures + ' FAILURE(S)'); process.exit(1) }
  console.log('\nALL PASS')
  process.exit(0)
}

// Recorder sender: captures every constructed page instead of spawning text-tate.js.
const sent = []
scheduler._setPagerSender((scriptPath, args) => { sent.push({ scriptPath, args }) })
function reset() { sent.length = 0; scheduler._resetBreakerState() }

// Sanity: env thresholds are the ones the module actually loaded.
ok('config reflects the shrunk env thresholds', () => {
  const c = scheduler._breakerConfig()
  assert.strictEqual(c.maxDispatches, 3)
  assert.strictEqual(c.windowMs, 60000)
  assert.strictEqual(c.sameNameMax, 5)
  assert.strictEqual(c.sameNameWindowMs, 120000)
})

// Faithful model of the dispatchOne flow for the AGGREGATE brake: check, and only
// if allowed, record. Returns the aggregate check result.
function aggAttempt(name, nowMs) {
  const agg = scheduler.breakerCheckAggregate(nowMs)
  if (agg.allow) scheduler.breakerRecordDispatch(name, nowMs)
  return agg
}

// ── 1. below the cap: allowed, no page ────────────────────────────────────────
ok('aggregate: below cap dispatches are allowed and never page', () => {
  reset()
  const t0 = 1_000_000
  for (let i = 0; i < 3; i++) {
    const r = aggAttempt('row-' + i, t0 + i * 100)
    assert.strictEqual(r.allow, true, 'dispatch ' + i + ' must be allowed below cap')
  }
  assert.strictEqual(sent.length, 0, 'no page below the cap')
  assert.strictEqual(scheduler._getBreakerState().dispatchCount, 3, '3 recorded')
  assert.strictEqual(scheduler._getBreakerState().frozen, false)
})

// ── 2. at the cap: freeze, exactly one page, latched ──────────────────────────
ok('aggregate: freezes at cap, fires exactly one page, latches (no spam)', () => {
  reset()
  const t0 = 2_000_000
  for (let i = 0; i < 3; i++) aggAttempt('row-' + i, t0 + i * 100)   // fill the window to cap=3
  const trip = scheduler.breakerCheckAggregate(t0 + 400)            // 4th attempt
  assert.strictEqual(trip.allow, false, '4th attempt must FREEZE')
  assert.strictEqual(trip.reason, 'window-freeze')
  assert.ok(trip.page, 'the freezing check returns the constructed page')
  assert.strictEqual(sent.length, 1, 'EXACTLY one page at freeze')
  assert.strictEqual(scheduler._getBreakerState().frozen, true)

  // Ten more frozen checks during the SAME episode: still exactly one page.
  for (let i = 0; i < 10; i++) {
    const r = scheduler.breakerCheckAggregate(t0 + 500 + i)
    assert.strictEqual(r.allow, false, 'still frozen')
  }
  assert.strictEqual(sent.length, 1, 'no further pages while latched')
})

// ── 3. page shape: text-tate.js, --from "runaway breaker", em-dash free ────────
ok('aggregate: page targets text-tate.js with the runaway-breaker label, no em-dash', () => {
  reset()
  const t0 = 3_000_000
  for (let i = 0; i < 3; i++) aggAttempt('r' + i, t0 + i)
  const trip = scheduler.breakerCheckAggregate(t0 + 10)
  const s = sent[0]
  assert.ok(/text-tate\.js$/.test(s.scriptPath), 'targets text-tate.js: ' + s.scriptPath)
  assert.strictEqual(s.args[0], '--from')
  assert.strictEqual(s.args[1], 'runaway breaker')
  // A last-resort page must be critical tier, not the fyi default: the send gate
  // lints fyi for operator vocabulary and this body names fleet machinery. Read
  // the message off the END rather than args[2], so adding a flag cannot make this
  // assertion silently measure the wrong string.
  const bu = s.args.indexOf('--urgency')
  assert.ok(bu !== -1, 'breaker page must carry an explicit --urgency')
  assert.strictEqual(s.args[bu + 1], 'critical', 'a breaker page is critical tier')
  const bmsg = s.args[s.args.length - 1]
  assert.ok(/RUNAWAY DISPATCH BREAKER TRIPPED/.test(bmsg), 'message names the breaker')
  assert.strictEqual(bmsg.indexOf('\u2014'), -1, 'no em-dash in the page body')
  assert.ok(trip.page.command.indexOf('\u2014') === -1, 'no em-dash in constructed command')
})

// ── 4. auto-clear when the window rolls ───────────────────────────────────────
ok('aggregate: freeze auto-clears once the window rolls below the cap', () => {
  reset()
  const t0 = 4_000_000
  for (let i = 0; i < 3; i++) aggAttempt('r' + i, t0 + i)
  assert.strictEqual(scheduler.breakerCheckAggregate(t0 + 10).allow, false, 'frozen at cap')

  // Jump past the 60s window: every recorded timestamp ages out, count -> 0.
  const later = t0 + 61_000
  const cleared = scheduler.breakerCheckAggregate(later)
  assert.strictEqual(cleared.allow, true, 'window rolled: dispatch resumes')
  assert.strictEqual(scheduler._getBreakerState().frozen, false, 'freeze latch cleared')

  // A fresh burst pages AGAIN (latch reset with the clear).
  for (let i = 0; i < 3; i++) aggAttempt('n' + i, later + i)
  const reTrip = scheduler.breakerCheckAggregate(later + 10)
  assert.strictEqual(reTrip.allow, false)
  assert.strictEqual(sent.length, 2, 'a fresh freeze episode pages again (2 total)')
})

// ── 5. operator manual reset file force-clears the freeze ─────────────────────
ok('aggregate: touching the reset file force-clears the window and unfreezes', () => {
  reset()
  const t0 = 5_000_000
  for (let i = 0; i < 3; i++) aggAttempt('r' + i, t0 + i)
  assert.strictEqual(scheduler.breakerCheckAggregate(t0 + 10).allow, false, 'frozen')

  fs.writeFileSync(scheduler._breakerConfig().resetFile, 'reset')
  const afterReset = scheduler.breakerCheckAggregate(t0 + 20)   // same instant, still inside window
  assert.strictEqual(afterReset.allow, true, 'reset file clears the window despite being in-window')
  assert.strictEqual(scheduler._getBreakerState().dispatchCount, 0, 'window emptied')
  assert.strictEqual(fs.existsSync(scheduler._breakerConfig().resetFile), false, 'reset file consumed (one-shot)')
})

// Faithful model of the dispatchOne flow for the SAME-NAME brake.
function nameAttempt(name, nowMs) {
  const sn = scheduler.breakerCheckSameName(name, nowMs)
  if (sn.allow) scheduler.breakerRecordDispatch(name, nowMs)
  return sn
}

// ── 6. same-name: a below-threshold name is never quarantined ─────────────────
ok('same-name: 5 dispatches of a name in-window stay allowed (below "more than 5")', () => {
  reset()
  const t0 = 6_000_000
  for (let i = 0; i < 5; i++) {
    const r = nameAttempt('healthy', t0 + i * 1000)
    assert.strictEqual(r.allow, true, 'dispatch ' + i + ' of a healthy name must be allowed')
  }
  assert.strictEqual(sent.length, 0, 'a below-threshold name never pages')
  assert.strictEqual(scheduler._getBreakerState().quarantined.length, 0)
})

// ── 7. same-name: a 5-in-2-min LOOP is quarantined, exactly one page ──────────
ok('same-name: a runaway loop (>5 in 2min) is quarantined with exactly one page', () => {
  reset()
  const t0 = 7_000_000
  let quarantinedAt = -1
  // A loop that keeps firing the same name every 10s. It clears the limit on its 6th
  // fire inside the 2-min window (strictly MORE than 5), the moment a runaway proves itself.
  for (let i = 0; i < 8; i++) {
    const now = t0 + i * 10_000
    const sn = nameAttempt('loopy', now)
    if (!sn.allow) {
      quarantinedAt = i
      // dispatchOne fires the quarantine page here.
      scheduler.breakerNoteQuarantine('loopy', sn.count)
      break
    }
  }
  assert.strictEqual(quarantinedAt, 5, 'quarantined on the 6th fire (index 5), i.e. more than 5 in 2min')
  assert.strictEqual(sent.length, 1, 'exactly one quarantine page')
  const qmsg = sent[0].args[sent[0].args.length - 1]
  assert.strictEqual(sent[0].args[sent[0].args.indexOf('--urgency') + 1], 'critical', 'a quarantine page is critical tier')
  assert.ok(/RUNAWAY TASK QUARANTINED/.test(qmsg))
  assert.ok(/"loopy"/.test(qmsg), 'page names the offending task')
  assert.strictEqual(qmsg.indexOf('\u2014'), -1, 'no em-dash in quarantine page')

  // Idempotent: a second quarantine note for the same name does not re-page.
  const again = scheduler.breakerNoteQuarantine('loopy', 9)
  assert.strictEqual(again, null, 'second quarantine note for the same name is a no-op')
  assert.strictEqual(sent.length, 1, 'still exactly one page for this name')
})

// ── 8. same-name window rolls: an old loop no longer trips ────────────────────
ok('same-name: fires that aged out of the window do not count toward the limit', () => {
  reset()
  const base = 8_000_000
  for (let i = 0; i < 5; i++) nameAttempt('slow', base + i * 1000)   // 5 fires early
  // Next fire is 3 min later: all 5 earlier fires aged out of the 2-min window.
  const r = nameAttempt('slow', base + 180_000)
  assert.strictEqual(r.allow, true, 'aged-out fires must not accumulate into a false quarantine')
})

// ── 9. quarantineRow issues the pause UPDATE (integration, stub pool) ──────────
ok('quarantineRow: pauses the row via last_status=paused and records the reason', async () => {
  const calls = []
  const stubPool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 } } }
  const res = await scheduler.quarantineRow(stubPool, { id: 'row-xyz' }, 7)
  assert.strictEqual(res.ok, true)
  assert.strictEqual(calls.length, 1, 'exactly one UPDATE')
  assert.ok(/UPDATE os_scheduled_tasks/.test(calls[0].sql))
  assert.ok(/last_status = 'paused'/.test(calls[0].sql), 'pauses via schedule_pause predicate')
  assert.ok(/leased_by = NULL/.test(calls[0].sql), 'releases the lease')
  assert.strictEqual(calls[0].params[0], 'row-xyz', 'scoped to the offending row id')
  assert.ok(/runaway breaker/.test(calls[0].params[1]), 'records the runaway-breaker reason')
})

// ── 9b. A quarantine must NOT read as a healthy active row ────────────────────
//
// REGRESSION, 2026-08-26 (task daead163). quarantineRow wrote status='active'
// alongside last_status='paused'. leaseDueRows excludes last_status IN
// ('paused','cancelled'), so the row could never fire again, while every ordinary
// status query read it as healthy. 35 rows died that way in one afternoon,
// including gmail-inbox-poll, which left inbound client mail dark for hours.
// Test 9 above could not catch it: it asserted last_status and never looked at
// status, so it passed identically before and after the defect. This one asserts
// the field that was wrong.
ok('quarantineRow: the pause is VISIBLE (status=paused, never active)', async () => {
  const calls = []
  const stubPool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 } } }
  await scheduler.quarantineRow(stubPool, { id: 'row-vis' }, 9)
  const sql = calls[0].sql
  assert.ok(/status = 'paused'/.test(sql), 'quarantine sets status=paused so it cannot masquerade as active')
  assert.ok(!/status = 'active'/.test(sql), 'quarantine must never leave status=active (the 2026-08-26 silent-death bug)')
})

// ── 10. quarantineRow never throws on a DB error (dispatch pass must survive) ──
ok('quarantineRow: a DB error is swallowed, not thrown', async () => {
  const badPool = { query: async () => { throw new Error('connection reset') } }
  const res = await scheduler.quarantineRow(badPool, { id: 'row-err' }, 6)
  assert.strictEqual(res.ok, false, 'reports failure')
  assert.ok(/connection reset/.test(res.error))
})

run()
