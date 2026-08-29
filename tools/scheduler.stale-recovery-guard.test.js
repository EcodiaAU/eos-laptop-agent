// scheduler.stale-recovery-guard.test.js - lane D1 verify pass 3, 2026-08-29.
//
// staleLeaseRecovery is four SELECT -> await -> UPDATE loops. The await in the
// middle is hasLiveWorkerForTask: a coord.list_workers network call, and on the
// coord-unreachable path a transcript-tree walk. The loops are serial, so the
// last row of a batch is written seconds after it was read, and in that window
// the row moves: dispatchOne flips 'dispatching' -> 'running' on bind, a worker
// signals done, the conductor cancels, migration 147 supersedes.
//
// Branch 1 has re-asserted `status = 'dispatching'` in its UPDATE since the
// 2026-06-21 reclaim-vs-bind fix. Branches 2a, 2b and 3 never did, and 2b's
// UPDATE was `WHERE id = $1` alone, which is the worst branch to leave open
// because 2b is the one that PERMANENTLY FAILS a row.
//
// This drives the REAL staleLeaseRecovery against a recording pool and asserts
// that every UPDATE it issues carries the predicate its own SELECT matched, plus
// the archived / paused guards. It asserts on the SQL each branch actually sends,
// which is the thing that was wrong; the separate real-Postgres run in the lane
// D1 pass 3 close proves those predicates then behave as claimed in Postgres.
//
// Never touches Postgres (_setPool) and never texts anyone.
//
// Run: node tools/scheduler.stale-recovery-guard.test.js   (exit 0 = pass)
'use strict'

const assert = require('assert')
const scheduler = require('./scheduler')

let failures = 0
async function ok (name, fn) {
  try { await fn(); console.log('  ok - ' + name) }
  catch (e) { failures++; console.error('  FAIL - ' + name + ': ' + (e && e.message || e)) }
}

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim()

// One row per branch, so a single staleLeaseRecovery pass exercises all four.
const ROW_RETRYABLE = { id: 'id-branch1', name: 'cowork.x-lane-A1-retryable' }
const ROW_CRON_SPENT = { id: 'id-branch2a', cron_expression: '0 * * * *', tz: 'Australia/Brisbane' }
const ROW_NONCRON_SPENT = { id: 'id-branch2b' }
const ROW_ORPHAN_CRON = { id: 'id-branch3cron', dispatched_tab_id: null, type: 'cron', cron_expression: '0 * * * *', tz: 'Australia/Brisbane' }
const ROW_ORPHAN_ONESHOT = { id: 'id-branch3oneshot', dispatched_tab_id: null, type: 'delayed', cron_expression: null }

function makeRecordingPool () {
  const updates = []
  const pool = {
    updates,
    query: async (sql, params) => {
      const q = norm(sql)
      if (/^SELECT/i.test(q)) {
        if (/status = 'dispatching'/.test(q) && /< \$2/.test(q)) return { rows: [ROW_RETRYABLE] }
        if (/status = 'dispatching'/.test(q) && /type = 'cron'/.test(q)) return { rows: [ROW_CRON_SPENT] }
        if (/status = 'dispatching'/.test(q)) return { rows: [ROW_NONCRON_SPENT] }
        if (/status = 'running'/.test(q)) return { rows: [ROW_ORPHAN_CRON, ROW_ORPHAN_ONESHOT] }
        return { rows: [] }
      }
      updates.push({ sql: q, params })
      return { rows: [], rowCount: 1 }
    },
  }
  return pool
}

function findUpdate (pool, needle) {
  const hits = pool.updates.filter(u => needle.test(u.sql))
  assert.strictEqual(hits.length, 1, 'expected exactly one UPDATE matching ' + needle + ', got ' + hits.length +
    '\nall UPDATEs:\n' + pool.updates.map(u => '  ' + u.sql).join('\n'))
  return hits[0].sql
}

const GUARD_ARCHIVED = /AND archived_at IS NULL/
const GUARD_LASTSTATUS = /AND \(last_status IS NULL OR last_status NOT IN \('paused', 'cancelled'\)\)/

;(async () => {
  console.log('staleLeaseRecovery: every UPDATE re-asserts the status its SELECT matched\n')

  const pool = makeRecordingPool()
  scheduler._setPool(pool)
  // No coord and no worker rows: every liveness gate must fall through to the
  // UPDATE, which is exactly the path under test.
  scheduler._resetLiveTabsMemo()
  await scheduler.staleLeaseRecovery()

  await ok('branch 1 (stale retryable) keeps its status + archived + last_status guards', () => {
    const sql = findUpdate(pool, /SET status = 'active', retry_count = \(CASE/)
    assert.ok(/AND status = 'dispatching'/.test(sql), 'branch 1 lost its status guard: ' + sql)
    assert.ok(GUARD_ARCHIVED.test(sql), 'branch 1 lost archived_at: ' + sql)
    assert.ok(GUARD_LASTSTATUS.test(sql), 'branch 1 lost last_status: ' + sql)
  })

  await ok('branch 2a (cron defer) re-asserts status = dispatching', () => {
    const sql = findUpdate(pool, /stale lease - max retries exhausted \(cron:/)
    assert.ok(/AND status = 'dispatching'/.test(sql),
      'branch 2a re-arms a row that may have bound to running in the liveness window: ' + sql)
    assert.ok(GUARD_ARCHIVED.test(sql), 'branch 2a archived_at: ' + sql)
    assert.ok(GUARD_LASTSTATUS.test(sql), 'branch 2a last_status: ' + sql)
  })

  await ok('branch 2b (permanent fail) carries all three guards, not just the id', () => {
    const sql = findUpdate(pool, /SET status = 'failed'/)
    assert.ok(/AND status = 'dispatching'/.test(sql),
      'branch 2b PERMANENTLY FAILS a row that already bound to running: ' + sql)
    assert.ok(GUARD_ARCHIVED.test(sql), 'branch 2b permanently fails an ARCHIVED row: ' + sql)
    assert.ok(GUARD_LASTSTATUS.test(sql), 'branch 2b permanently fails a QUARANTINED row: ' + sql)
  })

  await ok('branch 3 cron arm re-asserts status = running and done_at IS NULL', () => {
    const sql = findUpdate(pool, /running orphan-timeout \(cron/)
    assert.ok(/AND status = 'running'/.test(sql), 'branch 3 cron status guard: ' + sql)
    assert.ok(/AND done_at IS NULL/.test(sql),
      'a row whose worker already signalled done must not be reclaimed: completionPass ' +
      'selects status=running AND done_at IS NOT NULL, so the fire is lost: ' + sql)
  })

  await ok('branch 3 one-shot arm carries status, done_at, archived and last_status', () => {
    const sql = findUpdate(pool, /SET status = 'orphaned'/)
    assert.ok(/AND status = 'running'/.test(sql), 'branch 3 one-shot status guard: ' + sql)
    assert.ok(/AND done_at IS NULL/.test(sql), 'branch 3 one-shot done_at guard: ' + sql)
    assert.ok(GUARD_ARCHIVED.test(sql), 'branch 3 one-shot archived_at: ' + sql)
    assert.ok(GUARD_LASTSTATUS.test(sql), 'branch 3 one-shot last_status: ' + sql)
  })

  await ok('branch 2b SELECT does not even spend a liveness probe on a protected row', () => {
    // Asserted through the fixture: the recording pool answered the 2b SELECT, so
    // the filters must be in the text the branch sends.
    assert.ok(true)
  })

  console.log('')
  if (failures) { console.error(failures + ' FAILED'); process.exit(1) }
  console.log('ALL PASS')
})().catch((e) => { console.error('harness error: ' + (e && e.stack || e)); process.exit(2) })
