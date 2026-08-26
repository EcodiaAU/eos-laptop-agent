// Focused harness for the 2026-08-26 re-lease-while-live fix (status_board 76393b47).
// Run: node tools/scheduler.rearm-reentry-oneshot.test.js
//
// THE DEFECT. os_scheduled_tasks row 1acff6af (cowork.seedtree-lane-S2b-enrichment-build,
// a lane that WRITES to a client production database) was dispatched TWICE onto one
// ONE-SHOT row: tab ...f1fe7f54 at 12:23:12Z, tab ...19c302c6 at 13:12:38Z, final
// run_count=2 retry_count=2, next_run_at frozen at 12:20:00Z with last_run_at NULL for
// the whole 50 minute run. Frozen past-due next_run_at plus null last_run_at is exactly
// leaseDueRows' due-window, so the row stayed continuously leasable while its worker
// was alive.
//
// WHICH PATH. Four paths re-arm a row back to status='active'. Three recompute
// next_run_at (staleLeaseRecovery branch 1 -> NOW()+RETRY_BACKOFF_MS, branch 2a and
// markFailed's cron arm -> computeNextRunAt). markFailed's RETRYABLE branch did not
// touch next_run_at at all. The observed frozen 12:20:00Z discriminates the two
// candidates: branch 1 would have overwritten it with NOW()+backoff, markFailed's
// retryable branch leaves it exactly as found.
//
// WHY THE JUNE GUARD MISSED IT. The leaseDueRows re-entry guard merged 2026-06-20
// (2bcfa25) calls cronAlreadyRanThisPeriod, which returns false for type!=='cron' AND
// returns false when last_run_at is NULL. The incident row was both, so the guard was
// structurally unreachable for it. Case 5 below pins that honestly.
//
// Cases 1 and 2 FAIL against the pre-fix scheduler.js (no next_run_at in the retryable
// UPDATE). Case 3 FAILS against pre-fix (the row is returned as dispatchable).
// Cases 4 and 5 are the no-regression pins and pass either way.

const assert = require('assert')
const scheduler = require('./scheduler')

const RETRY_BACKOFF_MS = 5 * 60 * 1000   // contract: matches scheduler.js
const HOUR = 60 * 60 * 1000

let updates = []
let leaseRows = []

scheduler._setPool({
  async query(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim()
    // The lease statement is a CTE: `WITH due AS (SELECT ... FOR UPDATE SKIP LOCKED)
    // UPDATE os_scheduled_tasks t SET status = 'dispatching' ... RETURNING t.*`.
    // Matching it on startsWith('UPDATE') silently misses, the mock falls through to
    // the empty default, and leaseDueRows returns [] for EVERY case, which reads as a
    // pass on any "row must not be dispatched" assertion. Match the CTE head.
    if (s.startsWith('WITH due AS') && s.includes("SET status = 'dispatching'")) {
      return { rows: leaseRows, rowCount: leaseRows.length }
    }
    if (s.startsWith('UPDATE os_scheduled_tasks')) {
      updates.push({ sql: s, params })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  },
})
scheduler._setCoord({ async list_workers() { return { workers: [] } } })
scheduler._setDispatcher({ async kill_worker() { return { closed: true } } })
scheduler._setWorktreeFns({ pruneWorktreeForRow: async () => {} })

// Applies the ONE next_run_at form this fix emits, so the assertion reads the SQL the
// scheduler will really send rather than a restatement of it. Returns the new
// next_run_at in ms, or null when the UPDATE does not re-arm at all (the defect).
function applyNextRunAt(update, rowNextRunAtMs, nowMs) {
  const m = update.sql.match(/next_run_at = NOW\(\) \+ \(\$(\d+) \|\| ' milliseconds'\)::interval/)
  if (!m) return null
  const ms = update.params[Number(m[1]) - 1]
  assert.strictEqual(typeof ms, 'number', 'backoff param must be a number, got ' + typeof ms)
  return nowMs + ms
}

// leaseDueRows' due-predicate, verbatim in intent: a row is leasable when it is active
// and next_run_at <= NOW().
function isDue(nextRunAtMs, nowMs) { return nextRunAtMs <= nowMs }

let failures = 0
function check(label, fn) {
  try { fn(); console.log('  PASS  ' + label) }
  catch (e) { failures++; console.log('  FAIL  ' + label + '\n        ' + e.message) }
}

;(async () => {
  // ── Case 1: markFailed's retryable branch re-arms next_run_at ──────────────
  updates = []
  const oneShot = {
    id: '1acff6af-70a9-4529-9e7c-0abf41b92fd8',
    name: 'cowork.seedtree-lane-S2b-enrichment-build',
    type: 'delayed', cron_expression: null, retry_count: 0, run_count: 0,
    leased_by: 'lease-1', last_run_at: null,
  }
  await scheduler.markFailed(oneShot, new Error('bridge blip during dispatch'))

  const retryUpdate = updates.find(u =>
    u.sql.includes("SET status = 'active'") && u.sql.includes('retry_count = $1'))

  check('case 1: markFailed retryable branch issues an active re-arm', () => {
    assert.ok(retryUpdate, 'no retryable re-arm UPDATE was issued')
  })
  check('case 1: the re-arm moves next_run_at forward by the bounded backoff', () => {
    assert.ok(/next_run_at = NOW\(\)/.test(retryUpdate.sql),
      'retryable re-arm leaves next_run_at UNTOUCHED, so the row stays past-due and ' +
      'instantly re-leasable while its worker is still alive (the 2026-08-26 defect)')
    assert.ok(retryUpdate.params.includes(RETRY_BACKOFF_MS),
      'backoff param must be RETRY_BACKOFF_MS (' + RETRY_BACKOFF_MS + '), got params ' +
      JSON.stringify(retryUpdate.params.filter(x => typeof x === 'number')))
  })

  // ── Case 2: the incident window is closed ─────────────────────────────────
  // Replay the real shape: next_run_at 12:20:00Z, dispatch fails at 12:23, worker
  // still alive. Before the fix the row is due again on the very next 30s poll.
  check('case 2: after a retryable failure the row is NOT due on the next poll', () => {
    const dueAt = Date.parse('2026-08-26T12:20:00Z')
    const failedAt = Date.parse('2026-08-26T12:23:12Z')
    const nextPoll = failedAt + 30_000
    const rearmed = applyNextRunAt(retryUpdate, dueAt, failedAt)
    assert.ok(rearmed !== null,
      'no re-arm in the UPDATE: next_run_at stays ' + new Date(dueAt).toISOString() +
      ', so isDue(next poll) is true and a second tab opens on the live task')
    assert.strictEqual(isDue(rearmed, nextPoll), false,
      'row still due 30s after the failure (re-arm to ' + new Date(rearmed).toISOString() + ')')
    // And still not due at the 13:12:38Z moment the duplicate actually opened,
    // because 12:23:12 + 5min = 12:28:12 < 13:12:38. The backoff is bounded, so a
    // genuine retry DOES become due, which is the point of a bounded window.
    assert.strictEqual(isDue(rearmed, failedAt + RETRY_BACKOFF_MS + 1), true,
      'bounded backoff must still allow a legitimate retry after the window')
  })

  // ── Case 3: one-shot already ran this due-event is never dispatched ────────
  updates = []
  leaseRows = [{
    id: 'oneshot-already-ran', name: 'cowork.some-lane-A1', type: 'delayed',
    cron_expression: null, run_count: 1,
    next_run_at: '2026-08-26T12:20:00Z',
    last_run_at: '2026-08-26T13:13:22Z',   // at/after the due-event: already served
  }]
  const batch3 = await scheduler.leaseDueRows(5)
  check('case 3: a one-shot that already ran its due-event is dropped from the batch', () => {
    assert.strictEqual(batch3.length, 0,
      'row returned as dispatchable, which double-runs one-shot work (got ' +
      JSON.stringify(batch3.map(r => r.id)) + ')')
  })
  check('case 3: and it is settled to completed, not left re-leasable as active', () => {
    const settle = updates.find(u => u.sql.includes("SET status = 'completed'"))
    assert.ok(settle, 'no settle UPDATE issued; updates=' + JSON.stringify(updates.map(u => u.sql.slice(0, 60))))
    assert.ok(settle.sql.includes("status = 'dispatching'") && settle.sql.includes('leased_by = $2'),
      'settle UPDATE must be scoped to the lease we just took')
    assert.ok(settle.sql.includes("last_status NOT IN ('paused', 'cancelled')"),
      'settle UPDATE must carry the pause/cancel guard every other re-arm site carries')
  })

  // ── Case 4: no regression, schedule_run_now forced re-run still dispatches ──
  // run_now sets next_run_at = NOW() on a completed one-shot and does NOT reset
  // run_count, so a run_count-based refusal would have broken it. The due-event
  // test passes it through because NOW() is strictly after the old last_run_at.
  updates = []
  const now = Date.now()
  leaseRows = [{
    id: 'oneshot-forced-rerun', name: 'cowork.some-lane-A2', type: 'delayed',
    cron_expression: null, run_count: 3,
    next_run_at: new Date(now).toISOString(),
    last_run_at: new Date(now - HOUR).toISOString(),
  }]
  const batch4 = await scheduler.leaseDueRows(5)
  check('case 4: a schedule_run_now forced re-run is still dispatched', () => {
    assert.strictEqual(batch4.length, 1,
      'forced re-run was refused; run_count=3 must NOT be the test, the due-event must')
    assert.strictEqual(batch4[0].id, 'oneshot-forced-rerun')
    assert.ok(!updates.some(u => u.sql.includes("SET status = 'completed'")),
      'forced re-run must not be settled by the guard')
  })

  // ── Case 5: the honest pin, the guard alone would NOT have caught the incident ──
  // At the moment of the duplicate lease the incident row had last_run_at NULL, so
  // both re-entry guards fail open and the row IS dispatchable. Case 1/2 (the
  // markFailed re-arm) is the layer that actually closes this incident. Recording
  // that here stops a future reader crediting the wrong layer.
  updates = []
  leaseRows = [{
    id: 'incident-at-lease-time', name: 'cowork.seedtree-lane-S2b-enrichment-build',
    type: 'delayed', cron_expression: null, run_count: 0,
    next_run_at: '2026-08-26T12:20:00Z',
    last_run_at: null,
  }]
  const batch5 = await scheduler.leaseDueRows(5)
  check('case 5: guard fails open on last_run_at NULL (markFailed re-arm is the fix)', () => {
    assert.strictEqual(batch5.length, 1,
      'guard must fail OPEN on a never-run row; a guard that strands one-shot work ' +
      'is worse than the duplicate it prevents')
    assert.strictEqual(scheduler.oneShotAlreadyRanThisDueEvent(leaseRows[0]), false)
  })

  // ── Case 6: cron rows untouched by the one-shot guard ─────────────────────
  check('case 6: the one-shot guard never fires on a cron row', () => {
    assert.strictEqual(scheduler.oneShotAlreadyRanThisDueEvent({
      type: 'cron', cron_expression: '0 * * * *',
      next_run_at: '2026-08-26T12:00:00Z', last_run_at: '2026-08-26T13:00:00Z',
    }), false, 'cron rows are cronAlreadyRanThisPeriod territory, not this guard')
  })
  check('case 6: the one-shot guard fails open on unparseable or missing dates', () => {
    assert.strictEqual(scheduler.oneShotAlreadyRanThisDueEvent({ type: 'delayed' }), false)
    assert.strictEqual(scheduler.oneShotAlreadyRanThisDueEvent({
      type: 'delayed', next_run_at: 'not-a-date', last_run_at: 'also-not',
    }), false)
    assert.strictEqual(scheduler.oneShotAlreadyRanThisDueEvent(null), false)
  })

  // Case 7: the CLASS guard, not just this instance.
  // The defect was one re-arm path of many forgetting next_run_at. Pinning only
  // markFailed would let the next new path reintroduce it silently. Assert the
  // invariant over the source: every UPDATE that returns a row to 'active' AFTER a
  // worker may be live must also re-arm next_run_at. The only sanctioned exceptions
  // are the two PRE-SPAWN bails, where dispatchOne releases the lease before any
  // worker exists, so re-leasing cannot duplicate anything and leaving next_run_at
  // alone is what makes the row retry promptly once the suppression lifts.
  check('case 7: every post-spawn active re-arm also re-arms next_run_at', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'scheduler.js'), 'utf8')
    const PRE_SPAWN_BAILS = [
      'austerity',        // dispatchOne defense-in-depth austerity gate, released pre-spawn
      'aggregate breaker' // dispatchOne rolling-window freeze, released pre-spawn
    ]
    const offenders = []
    const re = /`(UPDATE os_scheduled_tasks[\s\S]*?)`/g
    let m
    while ((m = re.exec(src)) !== null) {
      const block = m.group ? m.group(1) : m[1]
      if (!block.includes("status = 'active'")) continue
      if (block.includes('next_run_at')) continue
      // Classify by the ~700 chars of context around the statement.
      const ctx = src.slice(Math.max(0, m.index - 700), m.index + 400).toLowerCase()
      if (PRE_SPAWN_BAILS.some(tag => ctx.includes(tag))) continue
      offenders.push(src.slice(0, m.index).split('\n').length)
    }
    assert.deepStrictEqual(offenders, [],
      'these UPDATEs return a row to active WITHOUT re-arming next_run_at, at lines ' +
      offenders.join(', ') + '. A row put back to active with a past-due next_run_at is ' +
      'immediately re-leasable, and if its worker is still alive that is a duplicate ' +
      'dispatch on the same task_id. Re-arm next_run_at (bounded RETRY_BACKOFF_MS for a ' +
      'retry, computeNextRunAt for a cron defer), or add the path to PRE_SPAWN_BAILS if ' +
      'it provably releases the lease before any worker is spawned.')
  })

  console.log(failures === 0
    ? '\nALL PASS (scheduler.rearm-reentry-oneshot)'
    : '\n' + failures + ' FAILING (scheduler.rearm-reentry-oneshot)')
  process.exit(failures === 0 ? 0 : 1)
})().catch(e => { console.error('harness error: ' + e.stack); process.exit(2) })
