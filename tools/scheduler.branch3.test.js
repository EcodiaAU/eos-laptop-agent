// Focused behavioural harness for staleLeaseRecovery branch 3 (status='running'
// orphan-timeout sweep) liveness gate. Run: node tools/scheduler.branch3.test.js
//
// Proves the 2026-06-18 fix: a stale-leased running row whose task HAS a live
// coord worker must NOT be reclaimed (gate fires); a stale-leased running row
// whose worker is dead/absent MUST still be reclaimed (no regression).
// Exercises the REAL staleLeaseRecovery code path via the module's injection
// seams (_setPool / _setCoord / _setDispatcher / _setWorktreeFns).

const scheduler = require('./scheduler')

const updates = []          // every UPDATE the routine issued, with params
const killed = []           // tab_ids kill_worker was called on

// Fake pool: route SELECTs to fixtures, record UPDATEs.
scheduler._setPool({
  async query(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim()
    // branch 1 bulk UPDATE (dispatching retryable)
    if (s.startsWith('UPDATE os_scheduled_tasks') && s.includes("status = 'dispatching'") && s.includes('retry_count + 1')) {
      return { rows: [], rowCount: 0 }
    }
    // branch 2a SELECT (stale cron) / 2b SELECT (stale non-cron) -> none
    if (s.startsWith('SELECT') && s.includes("status = 'dispatching'")) {
      return { rows: [] }
    }
    // branch 3 SELECT orphans (status='running')
    if (s.startsWith('SELECT') && s.includes("status = 'running'")) {
      return { rows: [
        { id: 'live-task', dispatched_tab_id: 'tabA', type: 'cron', cron_expression: '0 6 * * *', tz: 'Australia/Brisbane' },
        { id: 'dead-task', dispatched_tab_id: 'tabB', type: 'cron', cron_expression: '0 7 * * *', tz: 'Australia/Brisbane' },
      ] }
    }
    // any per-row UPDATE -> record
    if (s.startsWith('UPDATE os_scheduled_tasks')) {
      updates.push({ sql: s, params })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [] }
  },
})

// Fake coord: live worker exists ONLY for 'live-task'.
scheduler._setCoord({
  async list_workers() {
    return { workers: [
      { task_id: 'live-task', tab_id: 'tabLive', stale_ms: 5000, terminated_at: null, dead: false },
    ] }
  },
})

scheduler._setDispatcher({
  async kill_worker({ tab_id }) { killed.push(tab_id); return { closed: true } },
})

scheduler._setWorktreeFns({ pruneWorktreeForRow: async () => {} })

;(async () => {
  await scheduler.staleLeaseRecovery()

  const reclaimUpdates = updates.filter(u => u.sql.includes("status = 'active'") && /WHERE id = \$2/.test(u.sql))
  const reclaimedIds = reclaimUpdates.map(u => u.params[u.params.length - 1])

  const liveReclaimed = reclaimedIds.includes('live-task')
  const deadReclaimed = reclaimedIds.includes('dead-task')
  const liveKilled = killed.includes('tabA')
  const deadKilled = killed.includes('tabB')

  // Part 3: dead-task reclaim must set a strictly-future next_run_at.
  const deadUpdate = reclaimUpdates.find(u => u.params[u.params.length - 1] === 'dead-task')
  const deadNextRunAt = deadUpdate ? new Date(deadUpdate.params[0]).getTime() : 0
  const futureNextRun = deadNextRunAt > Date.now()

  const pass =
    !liveReclaimed &&   // gate fired: live worker NOT re-dispatched
    deadReclaimed &&    // no regression: dead worker reclaimed
    !liveKilled &&      // skip happened before kill_worker for live row
    deadKilled &&       // dead row's tab still cleaned up
    futureNextRun       // part 3: reclaim defers to a future interval

  console.log(JSON.stringify({
    liveReclaimed, deadReclaimed, liveKilled, deadKilled,
    deadNextRunAt: deadUpdate ? deadUpdate.params[0] : null, futureNextRun,
    reclaimedIds, killed,
  }, null, 2))
  console.log(pass ? 'PASS: branch-3 liveness gate works, no regression' : 'FAIL')
  process.exit(pass ? 0 : 1)
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2) })
