'use strict'
// scheduler.suspended-lease-settle.test.js
//
// A row can be suspended MID-LEASE: schedule_pause writes last_status='paused' and
// deliberately does not touch status, so pausing a task inside its dispatch or run
// window leaves `status IN ('dispatching','running') AND last_status='paused' AND
// archived_at IS NULL`. Before staleLeaseRecovery branch 0 nothing could move that
// row: branches 1 and 2b filter it out of their SELECTs, branches 2a and 3 select
// it, spend a coord liveness call, fire kill_worker, prune the worktree and then
// no-op their guarded UPDATE, every pass, forever. Meanwhile leaseDueRows' HOLDER
// predicate tests only `status IN ('running','dispatching')`, so the row holds its
// LANE and every future row on that lane defers behind it permanently.
//
// The controls are what make the passes mean anything. A settle branch that
// settled everything would free every lane and pass a naive "the lane reopened"
// assertion while retiring rows whose workers are alive, which is the collision
// the lane gate exists to stop. So: a live worker must be left strictly alone, a
// breaker-quarantined row (status='paused' already) must be unreachable, and the
// settle must re-assert every column its SELECT matched because the loop awaits a
// coord network call per row and the row moves underneath it.
//
// Pure unit: injected fake pool, injected stub coord, stub dispatcher, stub
// worktree fns. Touches no database, no coord, no transcript, no git.

const assert = require('assert')
let pass = 0, fail = 0
function ok(c, label) { if (c) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label) } }

const scheduler = require('./scheduler')

const SETTLE_SELECT_RE = /status IN \('dispatching', 'running'\)[\s\S]{0,200}last_status IN \('paused', 'cancelled'\)/

// Fake pool. Routes each SELECT by its shape: only the branch-0 SELECT gets rows,
// every other branch gets none, and the transcriptLivenessFallback point-lookup
// answers with a row carrying NO dispatched_tab_id so the oracle short-circuits
// (`if (!row.dispatched_tab_id) return null`) without touching a real transcript.
function fakePool(settleRows, opts) {
  opts = opts || {}
  const queries = []
  return {
    queries,
    updates: () => queries.filter(q => /^\s*UPDATE/i.test(q.sql)),
    query: async (sql, args) => {
      queries.push({ sql, args })
      if (/^\s*UPDATE/i.test(sql)) return { rows: [], rowCount: 1 }
      if (/SELECT id, name, leased_at, dispatched_tab_id/.test(sql)) {
        return { rows: [{ id: args[0], name: 'probe', leased_at: new Date(), dispatched_tab_id: opts.probeTabId || null }] }
      }
      if (SETTLE_SELECT_RE.test(sql)) return { rows: settleRows }
      return { rows: [] }
    },
  }
}

function harness(settleRows, coordWorkers, poolOpts) {
  const pool = fakePool(settleRows, poolOpts)
  const kills = [], prunes = []
  scheduler._setPool(pool)
  scheduler._setCoord({ list_workers: async () => ({ workers: coordWorkers || [] }) })
  scheduler._setDispatcher({ kill_worker: async (a) => { kills.push(a); return { closed: true } } })
  scheduler._setWorktreeFns({ prune: async (r) => { prunes.push(r.id) }, allocate: async () => ({}) })
  return { pool, kills, prunes }
}

async function testSettlesDispatching() {
  const h = harness([{ id: 'row-dispatching', name: 'cowork.x-lane-D1', type: 'delayed', dispatched_tab_id: 'tab_17879996746240_7211e67c' }])
  await scheduler.staleLeaseRecovery()
  const ups = h.pool.updates()
  ok(ups.length === 1, 'A1. a dispatching row suspended past the window produces exactly one settle UPDATE')
  const u = ups[0] || { sql: '' }
  ok(/SET status = last_status/.test(u.sql),
     'A2. it settles to status = last_status, not a hardcoded failed/orphaned')
  ok(/leased_by = NULL/.test(u.sql) && /leased_at = NULL/.test(u.sql),
     'A3. it releases the lease, which is what reopens the lane')
}

async function testSettlesRunning() {
  const h = harness([{ id: 'row-running', name: 'cowork.y-lane-D2', type: 'cron', dispatched_tab_id: null }])
  await scheduler.staleLeaseRecovery()
  ok(h.pool.updates().length === 1,
     'A4. the RUNNING half settles too (the half whose documented recovery, branch 3, cannot fire)')
}

async function testLiveWorkerUntouched() {
  const h = harness(
    [{ id: 'row-live', name: 'cowork.z-lane-D3', type: 'delayed', dispatched_tab_id: 'tab_17879996746241_7211e67c' }],
    [{ task_id: 'row-live', tab_id: 'tab_17879996746241_7211e67c', stale_ms: 1000, terminated_at: null }]
  )
  await scheduler.staleLeaseRecovery()
  ok(h.pool.updates().length === 0,
     'A5. CONTROL: a row whose worker is ALIVE is not settled, so the lane is never freed under a live tab')
  ok(h.kills.length === 0, 'A6. CONTROL: and its tab is not killed')
  ok(h.prunes.length === 0, 'A7. CONTROL: and its worktree is not pruned')
}

// Structural assertions on the SQL the branch issues. Behavioural tests cannot see
// a predicate that filters rows the fake pool was never asked for, and these are
// exactly the predicates whose absence caused the strand in the first place.
async function testPredicateShape() {
  const src = scheduler.staleLeaseRecovery.toString()
  const sel = (src.match(/SELECT id, name, type, dispatched_tab_id FROM os_scheduled_tasks[\s\S]*?`/) || [''])[0]
  ok(/status IN \('dispatching', 'running'\)/.test(sel),
     'B1. CONTROL: the settle SELECT is confined to dispatching/running, so a breaker-quarantined row (already status=paused) is unreachable')
  ok(/leased_at < NOW\(\) - \(\$1/.test(sel),
     'B2. CONTROL: it is windowed on leased_at, so a healthy row still inside its launch window is not settled')
  ok(/SUSPENDED_LEASE_SETTLE_MS/.test(src),
     'B3. the window is the dedicated settle constant, not STALE_DISPATCHING_MS (15min would retire a row mid cold-bind)')
  ok(/archived_at IS NULL/.test(sel) && /done_at IS NULL/.test(sel),
     'B4. it skips archived rows and rows completionPass still owns')

  const upd = (src.match(/SET status = last_status[\s\S]*?`/) || [''])[0]
  ok(/status IN \('dispatching', 'running'\)/.test(upd) && /last_status IN \('paused', 'cancelled'\)/.test(upd) &&
     /archived_at IS NULL/.test(upd) && /done_at IS NULL/.test(upd),
     'B5. the UPDATE re-asserts every column the SELECT matched (the row moves during the awaited coord call)')
}

// The asymmetry found alongside the strand: branch 2a was the one SELECT of the
// four missing the guards its own UPDATE re-asserts, so it probed and pruned rows
// it could never write.
async function testBranch2aSelectGuarded() {
  const src = scheduler.staleLeaseRecovery.toString()
  const sel = (src.match(/SELECT id, cron_expression, tz FROM os_scheduled_tasks[\s\S]*?`/) || [''])[0]
  ok(/archived_at IS NULL/.test(sel),
     'C1. branch 2a SELECT carries archived_at IS NULL, matching its own UPDATE')
  ok(/last_status NOT IN \('paused', 'cancelled'\)/.test(sel),
     'C2. branch 2a SELECT carries the last_status guard, so it stops pruning rows it cannot write')
}

;(async () => {
  console.log('[1] the strand settles')
  await testSettlesDispatching()
  await testSettlesRunning()
  console.log('[2] controls: a live worker is untouchable')
  await testLiveWorkerUntouched()
  console.log('[3] predicate shape')
  await testPredicateShape()
  console.log('[4] branch 2a SELECT/UPDATE symmetry')
  await testBranch2aSelectGuarded()
  console.log('')
  console.log(fail === 0 ? 'ALL PASS  (' + pass + ' passed, 0 failed)' : 'FAILURES  (' + pass + ' passed, ' + fail + ' failed)')
  process.exit(fail === 0 ? 0 : 1)
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2) })
