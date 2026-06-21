// Focused harness for the 2026-06-22 cadence-aware running-orphan reclaim in
// staleLeaseRecovery branch 3. Run: node tools/scheduler.branch3-cadence.test.js
//
// Proves: the branch-3 orphan SELECT is issued with a SHORT window for cron rows
// (RUNNING_CRON_ORPHAN_MS, default 30min) and the FULL 6h ORPHAN_TIMEOUT_MS for
// non-cron rows, AND the SQL structurally discriminates the two by type. A flat
// 6h window left a fast hourly cron whose worker died silently stuck 'running'
// for ~6h, blocking every intervening fire (gmail-inbox-poll, twice same shape).
// Downstream reclaim logic is unchanged, so a dead cron survivor still defers to
// its next interval (no regression vs scheduler.branch3.test.js).

const scheduler = require('./scheduler')

const RUNNING_CRON_ORPHAN_MS = 30 * 60 * 1000   // contract: matches scheduler.js default
const ORPHAN_TIMEOUT_MS = 6 * 60 * 60 * 1000    // contract: non-cron backstop unchanged

const updates = []
const killed = []
let branch3SelectParams = null
let branch3SelectSql = null

scheduler._setPool({
  async query(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim()
    // dispatching branches -> empty
    if (s.startsWith('UPDATE os_scheduled_tasks') && s.includes("status = 'dispatching'") && s.includes('retry_count + 1')) {
      return { rows: [], rowCount: 0 }
    }
    if (s.startsWith('SELECT') && s.includes("status = 'dispatching'")) {
      return { rows: [] }
    }
    // branch 3 orphan SELECT (status='running') -> capture params + return a dead cron row
    if (s.startsWith('SELECT') && s.includes("status = 'running'")) {
      branch3SelectSql = s
      branch3SelectParams = params
      return { rows: [
        { id: 'dead-cron', dispatched_tab_id: 'tabC', type: 'cron', cron_expression: '0 * * * *', tz: 'Australia/Brisbane' },
      ] }
    }
    if (s.startsWith('UPDATE os_scheduled_tasks')) {
      updates.push({ sql: s, params })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [] }
  },
})

// No live workers: the dead cron row must reclaim.
scheduler._setCoord({ async list_workers() { return { workers: [] } } })
scheduler._setDispatcher({ async kill_worker({ tab_id }) { killed.push(tab_id); return { closed: true } } })
scheduler._setWorktreeFns({ pruneWorktreeForRow: async () => {} })

;(async () => {
  await scheduler.staleLeaseRecovery()

  // 1. Two interval params, short window FIRST (cron), 6h SECOND (non-cron).
  const p = branch3SelectParams || []
  const cronWindowOk = p[0] === RUNNING_CRON_ORPHAN_MS
  const nonCronWindowOk = p[1] === ORPHAN_TIMEOUT_MS
  const cronFasterThanNonCron = p[0] < p[1]

  // 2. SQL structurally discriminates cron vs non-cron windows.
  const sql = branch3SelectSql || ''
  const discriminatesType = sql.includes("type = 'cron'") && sql.includes("type <> 'cron'")
  const stillRunningSweep = sql.includes("status = 'running'")

  // 3. No regression: the dead cron survivor reclaims (defer to next interval).
  const reclaimUpdates = updates.filter(u => u.sql.includes("status = 'active'") && /WHERE id = \$2/.test(u.sql))
  const reclaimedIds = reclaimUpdates.map(u => u.params[u.params.length - 1])
  const deadCronReclaimed = reclaimedIds.includes('dead-cron')
  const deadCronKilled = killed.includes('tabC')
  const deadUpdate = reclaimUpdates.find(u => u.params[u.params.length - 1] === 'dead-cron')
  const futureNextRun = deadUpdate ? new Date(deadUpdate.params[0]).getTime() > Date.now() : false

  const pass =
    cronWindowOk && nonCronWindowOk && cronFasterThanNonCron &&
    discriminatesType && stillRunningSweep &&
    deadCronReclaimed && deadCronKilled && futureNextRun

  console.log(JSON.stringify({
    branch3SelectParams: p, cronWindowOk, nonCronWindowOk, cronFasterThanNonCron,
    discriminatesType, stillRunningSweep, deadCronReclaimed, deadCronKilled, futureNextRun,
  }, null, 2))
  console.log(pass ? 'PASS: cadence-aware running-orphan reclaim (cron 30min, non-cron 6h), no downstream regression' : 'FAIL')
  process.exit(pass ? 0 : 1)
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2) })
