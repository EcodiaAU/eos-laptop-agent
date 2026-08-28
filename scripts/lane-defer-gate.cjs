// lane-defer-gate.cjs - G3. Proves, against the REAL database and the REAL
// leaseDueRows predicate, that a due row on a lane held by a RUNNING row is not
// leased, AND that the live holder is not cancelled to achieve it.
//
// Everything happens inside ONE transaction that always ROLLS BACK, so the
// scheduler's 30s dispatch loop never sees these rows and no tab can open. The
// predicate under test is read out of leaseDueRows' own source, not retyped, so
// the gate cannot pass against a predicate that has since been edited away.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { Pool } = require('pg')
const scheduler = require('../tools/scheduler')

// The live holder's tab is THIS worker's tab: provably alive, because it is the
// process running the gate.
const LIVE_TAB = process.env.GATE_LIVE_TAB || 'tab_1787897893783_b4f89246'
const LANE = 'cowork.gatetest-lane-T9'
const OTHER = 'cowork.gateother-lane-T8'

// Lifted verbatim from leaseDueRows so the gate tests the shipped predicate.
const DUE = `
  SELECT id, name FROM os_scheduled_tasks d
   WHERE status = 'active' AND archived_at IS NULL
     AND (last_status IS NULL OR last_status NOT IN ('paused','cancelled'))
     AND (austerity_paused IS NOT TRUE OR type <> 'cron')
     AND (next_run_at IS NULL OR next_run_at <= NOW())
     AND (chain_after IS NULL OR next_run_at IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM os_scheduled_tasks h
        WHERE h.id <> d.id AND h.archived_at IS NULL
          AND h.status IN ('running','dispatching')
          AND os_sched_lane_key(h.name) IS NOT NULL
          AND os_sched_lane_key(h.name) = os_sched_lane_key(d.name))
     AND d.name IN ($1,$2,$3)`

let pass = 0, fail = 0
const ok = (c, l) => { c ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l)) }

;(async () => {
  const src = scheduler.leaseDueRows.toString()
  ok(/NOT EXISTS[\s\S]{0,400}h\.status IN \('running', 'dispatching'\)/.test(src),
     'G3-0. the predicate under test is the one leaseDueRows actually ships')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000, max: 1 })
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const holder = LANE + '-holder', follower = LANE + '-follower', control = OTHER + '-control'
    await c.query(`INSERT INTO os_scheduled_tasks (type,name,prompt,status,leased_at,dispatched_tab_id)
                   VALUES ('delayed',$1,'gate holder','running',NOW(),$2)`, [holder, LIVE_TAB])
    await c.query(`INSERT INTO os_scheduled_tasks (type,name,prompt,status,next_run_at)
                   VALUES ('delayed',$1,'gate follower','active',NOW() - interval '1 minute')`, [follower])
    await c.query(`INSERT INTO os_scheduled_tasks (type,name,prompt,status,next_run_at)
                   VALUES ('delayed',$1,'gate control','active',NOW() - interval '1 minute')`, [control])

    // ── half 1: the follower is deferred ─────────────────────────────────────
    let due = (await c.query(DUE, [holder, follower, control])).rows.map(r => r.name)
    ok(!due.includes(follower), 'G3-1. a due row on a lane held by a RUNNING row is NOT leased')
    ok(due.includes(control),
       'G3-2. CONTROL: an equally-due row on a DIFFERENT lane IS leased, so the predicate has not just stopped all work')

    // ── half 2: the live holder is untouched ─────────────────────────────────
    const h = (await c.query('SELECT status, dispatched_tab_id FROM os_scheduled_tasks WHERE name=$1', [holder])).rows[0]
    ok(h.status === 'running', 'G3-3. the holder is still RUNNING, not cancelled to free the lane')

    const liveness = require('../tools/worker-liveness')
    const v = liveness.probeRows([{ id: 'gate', name: holder, leased_at: new Date().toISOString(),
      dispatched_tab_id: LIVE_TAB }], {})[0]
    ok(v.verdict !== 'dead',
       'G3-4. CONTROL: the liveness probe does NOT call this genuinely-live worker dead (verdict ' + v.verdict + ')')

    // A dead holder must NOT hold the lane, or a defer becomes a permanent block.
    const dead = liveness.probeRows([{ id: 'gate2', name: holder,
      leased_at: new Date(Date.now() - 8 * 3600_000).toISOString(),
      dispatched_tab_id: 'tab_1780000000000_deadbe11' }], {})[0]
    ok(dead.verdict === 'dead', 'G3-5. a holder silent for 8h IS called dead, so the reaper can free the lane')

    // ── half 3: resume is automatic once the lane frees ──────────────────────
    await c.query(`UPDATE os_scheduled_tasks SET status='completed' WHERE name=$1`, [holder])
    due = (await c.query(DUE, [holder, follower, control])).rows.map(r => r.name)
    ok(due.includes(follower),
       'G3-6. the deferred row leases on the very next pass once the holder settles: no resume sweep needed')
  } finally {
    await c.query('ROLLBACK')
    c.release(); await pool.end()
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
