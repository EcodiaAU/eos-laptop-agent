// conductor-claim-gate.cjs - proves the conductor-versus-worker interlock BOTH ways.
//
// Half one, the residual: a row the conductor has claimed is settled terminal and
// no tab is opened for it.
// Half two, the negative control: an equally-due UNCLAIMED row is untouched and
// still leasable, so the interlock has not simply stopped all work.
// Neither half counts without the other. A guard that blocks everything passes
// half one perfectly.
//
// The SQL under test is EXTRACTED FROM dispatchOne's shipped source at runtime,
// not retyped here, so this cannot pass against a statement that has since been
// edited away. Same technique as scripts/lane-defer-gate.cjs.
//
// Everything that can run inside a transaction does, and it always ROLLS BACK, so
// the 30s dispatch loop never sees these rows and no tab can open. The one leg
// that cannot (the conductor-claim.cjs subprocess opens its own pool) uses real
// rows pinned to next_run_at 2030 so the live leaser can never reach them, then
// deletes them and reads the absence back against a positive control.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { Pool } = require('pg')
const { execFileSync } = require('child_process')
const path = require('path')
const scheduler = require('../tools/scheduler')

const CLAIM_TAB = 'tab_claimgate_conductor'
const LANE_A = 'cowork.claimgate-lane-Q7'
const LANE_B = 'cowork.claimgateother-lane-Q8'
const FAR_FUTURE = '2030-01-01T00:00:00Z'

// Lifted verbatim from leaseDueRows so leasability is measured with the shipped predicate.
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
     AND d.id = ANY($1::uuid[])`

let pass = 0, fail = 0
const ok = (c, l) => { c ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l)) }

// -- extract the SHIPPED statements out of dispatchOne ------------------------
const SRC = scheduler.dispatchOne.toString()
const MARK = '0a. CONDUCTOR CLAIM INTERLOCK'
const iMark = SRC.indexOf(MARK)
// Anchor on the STATEMENT TEXT, never on block position. Counting backtick
// blocks broke the first time this ran, because the interlock's own comment
// quotes a column name in backticks and shifted every index by two. An
// extractor that can be fooled by a comment is not testing the shipped source.
function shippedStatement(prefix) {
  if (iMark < 0) return null
  let i = iMark
  for (;;) {
    const a = SRC.indexOf('`', i); if (a < 0) return null
    const b = SRC.indexOf('`', a + 1); if (b < 0) return null
    const body = SRC.slice(a + 1, b)
    if (body.trim().startsWith(prefix)) return body
    i = b + 1
  }
}
const SEL_CLAIM = shippedStatement('SELECT claimed_by_tab_id')
const UPD_SETTLE = shippedStatement('UPDATE os_scheduled_tasks')

;(async () => {
  // -- source legs: the interlock exists, precedes the spawn, settles terminal --
  ok(iMark > -1, 'S1. dispatchOne ships the conductor-claim interlock')
  ok(!!SEL_CLAIM && /claimed_by_tab_id/.test(SEL_CLAIM),
     'S2. the claim read is a real statement extracted from the shipped source')
  ok(!!UPD_SETTLE && /SET status = 'cancelled'/.test(UPD_SETTLE),
     'S3. the settle is a real statement extracted from the shipped source')
  ok(/catch \(e\)[\s\S]{0,400}conductor-claim check UNAVAILABLE/.test(SRC),
     'S4. the claim read fails OPEN in its own catch, so an unapplied migration 151 cannot kill every dispatch')
  {
    const iSpawn = SRC.search(/dispatched_tab_id = \$2|dispatcher\.dispatch_worker|spawnWorker|open_worker_tab/)
    ok(iMark > -1 && iSpawn > -1 && iMark < iSpawn,
       'S5. the interlock sits BEFORE the spawn, so a claimed row never reaches a tab')
  }
  ok(!!UPD_SETTLE && !/SET status = 'active'/.test(UPD_SETTLE),
     "S6. the disposition is a TERMINAL settle, not a release back to 'active' (which would spin every poll)")

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000, max: 1 })
  const c = await pool.connect()
  let mirrorId = null
  let posId = null
  try {
    await c.query('BEGIN')
    const mk = async (name, claim) => (await c.query(
      `INSERT INTO os_scheduled_tasks (type,name,prompt,status,next_run_at,claimed_by_tab_id,claimed_at)
       VALUES ('delayed',$1,'claim gate probe','active',NOW() - interval '1 minute',$2,
               CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END)
       RETURNING id`, [name, claim])).rows[0].id

    const A = await mk(LANE_A + '-claimed', CLAIM_TAB)   // residual: claimed
    const B = await mk(LANE_B + '-control', null)        // negative control: unclaimed, other lane
    // NOTE: no same-lane sibling is armed here. Two active rows on one lane is
    // exactly what the migration-147 INSERT trigger supersedes, so arming one
    // would cancel A and the residual leg would pass for the wrong reason. The
    // lane leg runs AFTER the settle instead, where it tests something real.
    const ids = [A, B]

    // Both rows are equally due before anything runs. Without this the control is
    // worthless: a row that was never leasable proves nothing by not being leased.
    let due = (await c.query(DUE, [ids])).rows.map(r => r.id)
    ok(due.includes(A) && due.includes(B),
       'G0. BASELINE: claimed and unclaimed rows are BOTH due before the interlock runs')

    // Post-lease state, which is where dispatchOne actually sees a row.
    const lease = 'gate-lease-1'
    await c.query(`UPDATE os_scheduled_tasks SET status='dispatching', leased_by=$2, leased_at=NOW()
                    WHERE id = ANY($1::uuid[])`, [[A, B], lease])

    // -- half one, the residual ------------------------------------------------
    const claimA = (await c.query(SEL_CLAIM, [A])).rows[0]
    ok(claimA && claimA.claimed_by_tab_id === CLAIM_TAB,
       'G1. the shipped claim read sees the conductor claim on the claimed row')

    await c.query(UPD_SETTLE, [A, lease,
      'claimed-by-conductor: ' + CLAIM_TAB + ' took this work onto its own thread at ' +
      new Date().toISOString() + '; no worker tab opened'])
    const a = (await c.query('SELECT status,last_status,result FROM os_scheduled_tasks WHERE id=$1', [A])).rows[0]
    ok(a.status === 'cancelled' && a.last_status === 'cancelled',
       'G2. the claimed row is settled TERMINAL, so it cannot be re-leased and re-checked forever')
    ok(/claimed-by-conductor: tab_claimgate_conductor/.test(a.result || ''),
       'G3. the row names the conductor tab that owes the work, so it audits as claimed and not as vanished')
    due = (await c.query(DUE, [ids])).rows.map(r => r.id)
    ok(!due.includes(A), 'G4. RESIDUAL: the claimed row is no longer leasable. No tab opens for it.')

    // -- half two, the negative control ----------------------------------------
    const claimB = (await c.query(SEL_CLAIM, [B])).rows[0]
    ok(claimB && !claimB.claimed_by_tab_id,
       'G5. the shipped claim read returns NO claim for the unclaimed row, so the interlock does not fire')
    const b = (await c.query('SELECT status,result FROM os_scheduled_tasks WHERE id=$1', [B])).rows[0]
    ok(b.status === 'dispatching' && !b.result,
       'G6. NEGATIVE CONTROL: the unclaimed row is untouched by the interlock and proceeds to dispatch')
    await c.query(`UPDATE os_scheduled_tasks SET status='active', leased_by=NULL, leased_at=NULL WHERE id=$1`, [B])
    due = (await c.query(DUE, [ids])).rows.map(r => r.id)
    ok(due.includes(B),
       'G7. NEGATIVE CONTROL: the unclaimed row is still leasable, so the interlock has not stopped all work')
    // G8. The settle must FREE the lane, not poison it. A claim that left the
    // lane held would convert every claimed row into a permanent lane block with
    // no liveness reaper able to clear it (a claim has no heartbeat).
    const C = await mk(LANE_A + '-after-claim', null)
    due = (await c.query(DUE, [[A, B, C]])).rows.map(r => r.id)
    ok(due.includes(C),
       'G8. the settled claim FREES the lane: a row armed on it afterwards leases normally')
  } finally {
    await c.query('ROLLBACK')
    c.release()
  }

  // -- the mirror half: a claim is REFUSED over a live worker tab --------------
  // conductor-claim.cjs opens its own pool, so this leg cannot live in the tx.
  // Pinned to 2030 so the live leaser can never reach it, addressed by id,
  // deleted and read back empty against a positive control.
  try {
    const r = await pool.query(
      `INSERT INTO os_scheduled_tasks (type,name,prompt,status,next_run_at,dispatched_tab_id)
       VALUES ('delayed',$1,'claim gate mirror probe','running',$2,'tab_claimgate_worker')
       RETURNING id`, [LANE_B + '-mirror', FAR_FUTURE])
    mirrorId = r.rows[0].id
    let refused = false, out = ''
    try {
      execFileSync(process.execPath,
        [path.join(__dirname, 'conductor-claim.cjs'), mirrorId, '--tab', CLAIM_TAB],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { refused = true; out = String(e.stderr || '') }
    ok(refused && /REFUSED/.test(out) && /running/.test(out),
       'M1. MIRROR HALF: a claim over a row a live worker tab already holds is REFUSED (worker is the incumbent)')
    // A helper that refuses EVERYTHING would pass M1 perfectly. Prove the claim
    // path actually works on a row with no tab, and that --release undoes it.
    const p2 = await pool.query(
      `INSERT INTO os_scheduled_tasks (type,name,prompt,status,next_run_at)
       VALUES ('delayed',$1,'claim gate positive probe','active',$2)
       RETURNING id`, [LANE_B + '-positive', FAR_FUTURE])
    posId = p2.rows[0].id
    let claimOut = ''
    try {
      claimOut = execFileSync(process.execPath,
        [path.join(__dirname, 'conductor-claim.cjs'), posId, '--tab', CLAIM_TAB],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { claimOut = 'THREW: ' + String(e.stderr || '') }
    const pRow = (await pool.query('SELECT claimed_by_tab_id, claimed_at FROM os_scheduled_tasks WHERE id=$1', [posId])).rows[0]
    ok(/^claimed /m.test(claimOut) && pRow && pRow.claimed_by_tab_id === CLAIM_TAB && !!pRow.claimed_at,
       'M1b. POSITIVE CONTROL: a claim on a row with NO tab succeeds and stamps the conductor tab')
    try {
      execFileSync(process.execPath,
        [path.join(__dirname, 'conductor-claim.cjs'), posId, '--release'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {}
    const rRow = (await pool.query('SELECT claimed_by_tab_id, claimed_at FROM os_scheduled_tasks WHERE id=$1', [posId])).rows[0]
    ok(rRow && !rRow.claimed_by_tab_id && !rRow.claimed_at,
       'M1c. --release clears the claim, so a conductor that hands the work back is not a one-way door')
    const m = (await pool.query('SELECT claimed_by_tab_id FROM os_scheduled_tasks WHERE id=$1', [mirrorId])).rows[0]
    ok(m && !m.claimed_by_tab_id, 'M2. the refused claim wrote nothing to the row')
  } finally {
    if (posId) await pool.query('DELETE FROM os_scheduled_tasks WHERE id=$1', [posId])
    if (mirrorId) {
      await pool.query('DELETE FROM os_scheduled_tasks WHERE id=$1', [mirrorId])
      // An absence probe truncated by head reads exactly like an absence, so read
      // the delete back against a positive control on the SAME filter.
      const gone = await pool.query('SELECT id FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])',
        [[mirrorId, posId].filter(Boolean)])
      const control = await pool.query('SELECT count(*)::int AS n FROM os_scheduled_tasks')
      ok(gone.rowCount === 0 && control.rows[0].n > 0,
         'M3. the mirror probe row is deleted and the read-back is a real empty, not a dead query')
    }
    await pool.end()
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
