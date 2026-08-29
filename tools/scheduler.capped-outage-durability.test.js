// scheduler.capped-outage-durability.test.js - lane D1 verify pass 2, 2026-08-29.
//
// Pass 1 shipped the capped-outage signal (c9e82bb): the defer marks retry_count
// at CAPPED_RETRY_MARK so scheduler-health.sh's capped_churn detector can see the
// outage, and noteAllAccountsCapped pages Tate once. This file covers the three
// things that pass was too close to see.
//
//  1. THE PARALLEL PATH. markFailed was guarded against inheriting a cap-marked
//     retry_count (isAllAccountsCappedMarker). staleLeaseRecovery was NOT, and it
//     compares retry_count to MAX_RETRY_COUNT in all three of its branches.
//     leaseDueRows' UPDATE sets only status/leased_by/leased_at/updated_at, so a
//     cap-marked row re-enters 'dispatching' still carrying retry_count=2 and the
//     marker in last_error. Branch 1 then grants it ONE reclaim (2 -> 3) and the
//     next stale pass sends it to branch 2b, which permanently fails it. A row
//     that should get three reclaims gets one. Measured live 2026-08-29: 121 of
//     128 rows carrying the marker are type='delayed', which is exactly the type
//     branch 2b permanently fails. And a cap outage ENDS in a thundering herd
//     (~90 rows lease at once when it clears), which is when a spawn is likeliest
//     to go stale, so the correlation points the wrong way.
//
//  2. THE LATCH DIED WITH THE DAEMON. _cappedFirstDeferAt and _cappedPageSent
//     were process memory. A cap outage CORRELATES with restarts, because a cap
//     is exactly when account-switch fires and when watchdogs act. Page at 10min,
//     restart, clock zeroes, page again at 20min. Inverse: restart at 9min and
//     the page is pushed out another 10.
//
//  3. THE 3AM TEST. The page rendered the earliest reset as an ISO UTC stamp with
//     sub-second precision. Doctrine is AEST to Tate, UTC to machines.
//
// Every send is stubbed via _setPagerSender, every query via _setPool, and the
// state file is redirected via _setCappedStatePath: this test NEVER texts Tate,
// NEVER touches Postgres, and NEVER writes the real state file.
//
// Run: node tools/scheduler.capped-outage-durability.test.js   (exit 0 = pass)
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const scheduler = require('./scheduler')

let failures = 0
async function ok(name, fn) {
  try { await fn(); console.log('  ok - ' + name) }
  catch (e) { failures++; console.error('  FAIL - ' + name + ': ' + (e && e.message || e)) }
}

const T0 = 1756000000000
const MIN = 60 * 1000
const STATE_PATH = path.join(os.tmpdir(), 'sched-capped-state-test-' + process.pid + '.json')

const sent = []
const queries = []
let selectRows = {}

const cappedErr = (resets) => {
  const e = new Error('all enabled accounts are capped')
  e.name = 'AllAccountsCappedError'
  if (resets) e.resets = resets
  return e
}

// Routes a query to a canned result by SQL shape so staleLeaseRecovery's three
// SELECTs can be driven independently. Anything unmatched returns no rows, which
// is the safe direction for every branch here.
function installPool() {
  scheduler._setPool({
    query: async (sql, params) => {
      queries.push({ sql, params })
      if (/FROM os_scheduled_tasks/i.test(sql) && /^\s*SELECT/i.test(sql)) {
        if (/status = 'dispatching'/.test(sql) && /retry_count|CASE/i.test(sql)) {
          if (/type = 'cron'/.test(sql)) return { rows: selectRows.cron || [], rowCount: 0 }
          if (/type != 'cron'/.test(sql)) return { rows: selectRows.noncron || [], rowCount: 0 }
          return { rows: selectRows.retryable || [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    },
  })
}

function reset() {
  sent.length = 0
  queries.length = 0
  selectRows = {}
  try { fs.unlinkSync(STATE_PATH) } catch (_e) {}
  scheduler._setCappedStatePath(STATE_PATH)
  scheduler._resetCappedOutageState()
  scheduler._setCoord({ list_workers: async () => ({ workers: [] }) })
  scheduler.pruneWorktreeForRow = async () => {}
  scheduler._setPagerSender((scriptPath, args, done) => {
    sent.push({ scriptPath, args })
    if (done) done(null, 0)
  })
  installPool()
}

;(async () => {
console.log('scheduler.capped-outage-durability.test.js')

// ── 1. staleLeaseRecovery must not inherit a cap-marked retry_count ──────────

await ok('a shared constant defines the marker for BOTH the JS test and the SQL', async () => {
  reset()
  assert.ok(typeof scheduler.CAPPED_MARKER_TOKEN === 'string' && scheduler.CAPPED_MARKER_TOKEN.length > 0,
    'CAPPED_MARKER_TOKEN must be exported so the JS regex and the SQL ILIKE cannot drift apart')
  assert.ok(scheduler.isAllAccountsCappedMarker('AllAccountsCappedError - deferred 76min'),
    'the JS predicate must match the marker the defer writes')
  assert.ok(scheduler.EFFECTIVE_RETRY_COUNT_SQL.includes(scheduler.CAPPED_MARKER_TOKEN),
    'the SQL expression must be built from the same token, not a hand-copied literal')
})

await ok('branch 1 (stale retryable) reads an EFFECTIVE retry count, not the raw column', async () => {
  reset()
  await scheduler.staleLeaseRecovery()
  const sel = queries.filter(q => /^\s*SELECT/i.test(q.sql) && /status = 'dispatching'/.test(q.sql))
  assert.ok(sel.length >= 3, 'expected the three staleLeaseRecovery SELECTs, saw ' + sel.length)
  const b1 = sel[0]
  assert.ok(/CASE\s+WHEN\s+last_error\s+ILIKE/i.test(b1.sql),
    'branch 1 must neutralise a cap-marked count, or a cap outage spends 2 of 3 reclaims: ' + b1.sql)
})

await ok('branches 2a and 2b (max retries exhausted) read the same EFFECTIVE count', async () => {
  reset()
  await scheduler.staleLeaseRecovery()
  const sel = queries.filter(q => /^\s*SELECT/i.test(q.sql) && /status = 'dispatching'/.test(q.sql))
  const cron = sel.find(q => /type = 'cron'/.test(q.sql))
  const noncron = sel.find(q => /type != 'cron'/.test(q.sql))
  assert.ok(cron && /CASE\s+WHEN\s+last_error\s+ILIKE/i.test(cron.sql), 'branch 2a must use the effective count: ' + (cron && cron.sql))
  assert.ok(noncron && /CASE\s+WHEN\s+last_error\s+ILIKE/i.test(noncron.sql),
    'branch 2b PERMANENTLY FAILS the row, so it above all must use the effective count: ' + (noncron && noncron.sql))
})

await ok('branch 1 UPDATE writes effective+1, so a cap-marked row reclaims to 1 not 3', async () => {
  reset()
  selectRows.retryable = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'cowork.x-lane-D1-a' }]
  await scheduler.staleLeaseRecovery()
  const upd = queries.find(q => /^\s*UPDATE/i.test(q.sql) && /stale lease recovered/.test(q.sql))
  assert.ok(upd, 'branch 1 must have run its UPDATE')
  assert.ok(!/retry_count\s*=\s*retry_count\s*\+\s*1/.test(upd.sql),
    'raw retry_count+1 carries the cap mark forward and burns the budget: ' + upd.sql)
  assert.ok(/CASE\s+WHEN\s+last_error\s+ILIKE/i.test(upd.sql),
    'the UPDATE must increment the EFFECTIVE count: ' + upd.sql)
})

// ── 2. the latch must survive a daemon restart ──────────────────────────────

await ok('a capped defer PERSISTS the outage clock to disk', async () => {
  reset()
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0)
  assert.ok(fs.existsSync(STATE_PATH), 'the outage clock must survive the process, or a restart re-zeroes it')
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  assert.strictEqual(st.firstDeferAt, T0, 'firstDeferAt persisted')
  assert.strictEqual(st.pageSent, false, 'no page yet at t0')
})

await ok('a RESTART mid-outage does not re-zero the clock (no delayed page)', async () => {
  reset()
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0)
  scheduler._simulateRestart(T0 + 11 * MIN)          // in-memory state gone, file remains
  // 11min after the FIRST defer. With the clock restored this crosses the 10min gate.
  const page = await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0 + 11 * MIN)
  assert.ok(page, 'the page must fire on the restored clock, not restart from zero')
  assert.strictEqual(sent.length, 1, 'exactly one page')
})

await ok('a RESTART after the page does not fire a SECOND page (no double-page)', async () => {
  reset()
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0)
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0 + 11 * MIN)
  assert.strictEqual(sent.length, 1, 'first page sent')
  scheduler._simulateRestart(T0 + 22 * MIN)
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0 + 22 * MIN)
  assert.strictEqual(sent.length, 1, 'the latch must survive the restart; a second page here is the bug')
})

await ok('a recovered dispatch CLEARS the persisted state (a later outage still pages)', async () => {
  reset()
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0)
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0 + 11 * MIN)
  assert.strictEqual(sent.length, 1)
  scheduler.noteSuccessfulDispatch()
  assert.ok(!fs.existsSync(STATE_PATH),
    'a stale pageSent=true left on disk would SILENCE the next outage, which is worse than a double page')
  scheduler._simulateRestart(T0 + 40 * MIN)
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0 + 40 * MIN)
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0 + 55 * MIN)
  assert.strictEqual(sent.length, 2, 'the NEXT outage must page afresh')
})

await ok('a STALE persisted outage is discarded, not resurrected', async () => {
  reset()
  fs.writeFileSync(STATE_PATH, JSON.stringify({ firstDeferAt: T0 - 100 * MIN, defers: 40, pageSent: true, lastDeferAt: T0 - 90 * MIN }))
  scheduler._simulateRestart(T0)
  const st = scheduler._getCappedOutageState()
  assert.strictEqual(st.firstDeferAt, null,
    'an outage whose last defer is far in the past ended; adopting pageSent=true from it silences the next one')
})

await ok('a corrupt state file falls back to in-memory behaviour, never a crash', async () => {
  reset()
  fs.writeFileSync(STATE_PATH, '{not json at all')
  scheduler._simulateRestart(T0)
  const page = await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0)
  assert.strictEqual(page, null, 'first defer, no page')
  assert.strictEqual(scheduler._getCappedOutageState().defers, 1, 'the dispatcher must not crash-loop on its own state file')
})

await ok('an UNCONFIRMED send unlatches on disk too, so the retry actually retries', async () => {
  reset()
  scheduler._setPagerSender((scriptPath, args, done) => { sent.push({ scriptPath, args }); if (done) done(null, 1) })
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0)
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(), T0 + 11 * MIN)
  assert.strictEqual(sent.length, 1, 'one attempt made')
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  assert.strictEqual(st.pageSent, false,
    'the send did not confirm exit 0, so disk must show unlatched or a restart adopts a page that never landed')
})

// ── 3. the 3am test ─────────────────────────────────────────────────────────

await ok('the page names the reset in AEST, the timezone Tate reads at 3am', async () => {
  reset()
  const resets = { tate: '2026-09-01T11:00:00.472080+00:00', code: '2026-08-29T08:00:00.435616+00:00', money: '2026-08-29T08:30:00.108327+00:00' }
  await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(resets), T0)
  const page = await scheduler.handleAllAccountsCappedDefer({ id: 'r1', type: 'delayed' }, cappedErr(resets), T0 + 11 * MIN)
  assert.ok(page, 'page fired')
  assert.ok(/AEST/.test(page.message), 'doctrine is AEST to Tate, UTC to machines: ' + page.message)
  assert.ok(/18:00/.test(page.message), 'the earliest reset 08:00Z is 18:00 AEST: ' + page.message)
  assert.ok(!/\.\d{3}Z/.test(page.message), 'sub-second ISO precision is machine noise in a 3am text: ' + page.message)
})

try { fs.unlinkSync(STATE_PATH) } catch (_e) {}
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
})()
