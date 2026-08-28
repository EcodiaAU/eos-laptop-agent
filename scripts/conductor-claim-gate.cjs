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
// BOUND THE SEARCH TO THE INTERLOCK BLOCK (2026-08-28, lane R1).
// The extractors used to scan from iMark to the end of dispatchOne. When the
// deliberate-breakage control reverted the cron branch, the "cron defer" extractor
// did not go null as intended - it walked past the interlock and matched a totally
// unrelated later `UPDATE ... SET status = 'active'` in the same function, which
// takes a different parameter count. The gate then died on a Postgres 08P01 bind
// error instead of reporting a failed leg. An extractor that can wander outside the
// block it is named for is testing something other than what it claims.
const iEnd = (() => {
  const e = SRC.indexOf('0b. Runaway circuit breaker', iMark < 0 ? 0 : iMark)
  return e > -1 ? e : SRC.length
})()
const BLOCK = iMark < 0 ? '' : SRC.slice(iMark, iEnd)
// Anchor on the STATEMENT TEXT, never on block position. Counting backtick
// blocks broke the first time this ran, because the interlock's own comment
// quotes a column name in backticks and shifted every index by two. An
// extractor that can be fooled by a comment is not testing the shipped source.
// The interlock now ships THREE dispositions, so selecting "the first UPDATE" would
// silently test whichever one happens to be written first. Each is picked by the
// content that makes it that branch.
function shippedStatementWhere(prefix, pred) {
  if (iMark < 0 || !BLOCK) return null
  let i = 0
  for (;;) {
    const a = BLOCK.indexOf('`', i); if (a < 0) return null
    const b = BLOCK.indexOf('`', a + 1); if (b < 0) return null
    const body = BLOCK.slice(a + 1, b)
    if (body.trim().startsWith(prefix) && pred(body)) return body
    i = b + 1
  }
}
function shippedStatement(prefix) {
  return shippedStatementWhere(prefix, () => true)
}
const SEL_CLAIM  = shippedStatement('SELECT claimed_by_tab_id')
const UPD_CANCEL = shippedStatementWhere('UPDATE os_scheduled_tasks', b => /SET status = 'cancelled'/.test(b))
const UPD_DEFER  = shippedStatementWhere('UPDATE os_scheduled_tasks', b => /SET status = 'active'/.test(b))
const UPD_CLEAR  = shippedStatementWhere('UPDATE os_scheduled_tasks', b => /SET claimed_by_tab_id = NULL/.test(b))
const UPD_SETTLE = UPD_CANCEL

;(async () => {
  // -- source legs: the interlock exists, precedes the spawn, settles terminal --
  ok(iMark > -1, 'S1. dispatchOne ships the conductor-claim interlock')
  ok(!!SEL_CLAIM && /claimed_by_tab_id/.test(SEL_CLAIM),
     'S2. the claim read is a real statement extracted from the shipped source')
  ok(!!UPD_CANCEL && /SET status = 'cancelled'/.test(UPD_CANCEL),
     'S3. the one-shot terminal settle is a real statement extracted from the shipped source')
  ok(/catch \(e\)[\s\S]{0,400}conductor-claim check UNAVAILABLE/.test(SRC),
     'S4. the claim read fails OPEN in its own catch, so an unapplied migration 151 cannot kill every dispatch')
  {
    const iSpawn = SRC.search(/dispatched_tab_id = \$2|dispatcher\.dispatch_worker|spawnWorker|open_worker_tab/)
    ok(iMark > -1 && iSpawn > -1 && iMark < iSpawn,
       'S5. the interlock sits BEFORE the spawn, so a claimed row never reaches a tab')
  }
  ok(!!UPD_CANCEL && !/SET status = 'active'/.test(UPD_CANCEL),
     "S6. the ONE-SHOT disposition is a TERMINAL settle, not a release back to 'active' (which would spin every poll)")
  // S7-S10 added 2026-08-28 (lane R1). The first cut of this interlock had exactly
  // one disposition - terminal cancel - applied to every row type. For a CRON row
  // that is a permanent kill: leaseDueRows drops last_status IN ('paused','cancelled')
  // and schedule_resume refuses anything not last_status='paused', so no exposed tool
  // could revive it. Same family as the 2026-06-09 stranding of 23 corpus rows.
  ok(!!UPD_DEFER && /SET status = 'active'/.test(UPD_DEFER) && /next_run_at/.test(UPD_DEFER),
     'S7. a CRON disposition exists and DEFERS (status active + a recomputed next_run_at), rather than killing the cadence')
  ok(!!UPD_DEFER && /last_status = NULL/.test(UPD_DEFER),
     "S8. the cron defer clears last_status, so leaseDueRows' ('paused','cancelled') filter cannot strand it")
  ok(/row\.type === 'cron'/.test(SRC) && /cron_expression/.test(SRC),
     'S9. the branch is chosen by the row TYPE, so a one-shot still settles terminal and a cron never does')
  ok(!!UPD_CLEAR && /claimed_at = NULL/.test(UPD_CLEAR) && /ORPHAN_TIMEOUT_MS/.test(SRC),
     'S10. an ABANDONED claim (older than the orphan timeout) is cleared, so a dead conductor cannot suppress a row forever')

  // A missing statement must FAIL, never THROW. When an extractor returns null the
  // DB legs below would call pool.query(null) and the whole gate dies with a stack
  // trace - and a crash and a refusal are both "non-zero exit with stderr", which is
  // exactly how this lane's conductor-claim.cjs scored a crash as green on 2026-08-28.
  // Guarding here means a deleted disposition is reported as the specific legs it
  // breaks, with a real pass/fail count, instead of as an abort.
  const MISSING = [
    ['SELECT claimed_by_tab_id', SEL_CLAIM],
    ["the one-shot cancel", UPD_CANCEL],
    ["the cron defer", UPD_DEFER],
    ["the abandoned-claim clear", UPD_CLEAR],
  ].filter(([, v]) => !v).map(([k]) => k)
  // Arity check. A statement that extracted but takes a different number of binds
  // than the leg passes it produces a Postgres 08P01 protocol error mid-run, which
  // reads as a crash rather than as a failed assertion.
  const arity = (q) => { const m = String(q||'').match(/\$(\d+)/g) || []; return m.length ? Math.max(...m.map(x => +x.slice(1))) : 0 }
  const ARITY = [['the one-shot cancel', UPD_CANCEL, 3], ['the cron defer', UPD_DEFER, 4], ['the abandoned-claim clear', UPD_CLEAR, 1]]
  for (const [label, q, want] of ARITY) {
    if (q && arity(q) !== want) MISSING.push(label + ' (extracted but takes $' + arity(q) + ', the leg binds ' + want + ')')
  }
  if (MISSING.length) {
    for (const m of MISSING) ok(false, 'PRE. shipped statement missing from dispatchOne: ' + m)
    console.log('')
    console.log(pass + ' passed, ' + fail + ' failed')
    console.log('ABORTING the database legs: they exercise the statements above, and running them')
    console.log('with a null statement would crash rather than report. Fix the source and re-run.')
    process.exit(1)
  }

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

    // -- CRON legs (added 2026-08-28, lane R1) ---------------------------------
    // The defect these exist for: the interlock cancelled every claimed row, and a
    // cancelled CRON is unrecoverable by any exposed tool. Each leg below is paired
    // with the control that separates "deferred correctly" from "broken in a way
    // that happens to look quiet".
    const mkCron = async (name, claim, claimAgeSql) => (await c.query(
      `INSERT INTO os_scheduled_tasks (type,name,prompt,status,cron_expression,tz,next_run_at,claimed_by_tab_id,claimed_at)
       VALUES ('cron',$1,'claim gate cron probe','active','*/5 * * * *','Australia/Brisbane',
               NOW() - interval '1 minute',$2,
               CASE WHEN $2::text IS NULL THEN NULL ELSE ${claimAgeSql} END)
       RETURNING id`, [name, claim])).rows[0].id

    const CR = await mkCron(LANE_A + '-cron-claimed', CLAIM_TAB, 'NOW()')
    const CU = await mkCron(LANE_B + '-cron-control', null, 'NOW()')
    const cronIds = [CR, CU]
    let cdue = (await c.query(DUE, [cronIds])).rows.map(r => r.id)
    ok(cdue.includes(CR) && cdue.includes(CU),
       'C0. BASELINE: claimed and unclaimed CRON rows are BOTH due before the interlock runs')

    await c.query(`UPDATE os_scheduled_tasks SET status='dispatching', leased_by=$2, leased_at=NOW()
                    WHERE id = ANY($1::uuid[])`, [cronIds, 'gate-lease-cron'])

    const nextIso = scheduler.computeNextRunAt({ cron_expression: '*/5 * * * *', tz: 'Australia/Brisbane' })
    await c.query(UPD_DEFER, [CR, 'gate-lease-cron', nextIso,
      'claimed-by-conductor: ' + CLAIM_TAB + ' took this occurrence onto its own thread; cron deferred'])
    const cr = (await c.query(
      'SELECT status,last_status,next_run_at,claimed_by_tab_id,result FROM os_scheduled_tasks WHERE id=$1', [CR])).rows[0]
    ok(cr.status === 'active' && cr.last_status === null,
       'C1. the claimed CRON is DEFERRED (active, last_status cleared), not terminally cancelled')
    ok(new Date(cr.next_run_at).getTime() > Date.now(),
       'C2. the deferred cron got a FUTURE next_run_at, so it skips this occurrence rather than spinning on the same one')
    ok(cr.claimed_by_tab_id === CLAIM_TAB,
       'C3. the claim is RETAINED across the defer, so a conductor arc spanning intervals keeps suppressing the tab')
    cdue = (await c.query(DUE, [cronIds])).rows.map(r => r.id)
    ok(!cdue.includes(CR),
       'C4. RESIDUAL: the deferred cron is not due right now, so no tab opens for this occurrence')

    // THE leg that would have caught the original defect. A terminally-cancelled
    // cron also fails C4 - "not due now" is satisfied by a dead row just as well as
    // by a deferred one. Survival is what separates them: wind next_run_at back and
    // the row must return. A cancelled row never would.
    await c.query(`UPDATE os_scheduled_tasks SET next_run_at = NOW() - interval '1 minute' WHERE id=$1`, [CR])
    cdue = (await c.query(DUE, [cronIds])).rows.map(r => r.id)
    ok(cdue.includes(CR),
       'C5. POSITIVE CONTROL: the deferred cron IS leasable again at its next interval. The cadence survived the claim.')

    const cu = (await c.query('SELECT status,result FROM os_scheduled_tasks WHERE id=$1', [CU])).rows[0]
    ok(cu.status === 'dispatching' && !cu.result,
       'C6. NEGATIVE CONTROL: the unclaimed cron is untouched by the interlock')

    // Abandoned-claim escape hatch: nothing expires a claim, so a conductor that
    // dies mid-arc would otherwise suppress this row for all time.
    const CS = await mkCron(LANE_A + '-cron-stale', CLAIM_TAB, "NOW() - interval '7 hours'")
    const stale = (await c.query(SEL_CLAIM, [CS])).rows[0]
    ok(stale && (Date.now() - new Date(stale.claimed_at).getTime()) > 6 * 60 * 60 * 1000,
       'C7. a 7h-old claim is past the 6h orphan bound the interlock treats as abandoned')
    await c.query(UPD_CLEAR, [CS])
    const cleared = (await c.query(SEL_CLAIM, [CS])).rows[0]
    ok(cleared && !cleared.claimed_by_tab_id && !cleared.claimed_at,
       'C8. the shipped clear statement actually releases an abandoned claim, so the row can dispatch again')

    // schedule_resume must clear the claim, or a resume reports ok and changes nothing.
    const RS = await mkCron(LANE_B + '-cron-resume', CLAIM_TAB, 'NOW()')
    await c.query(`UPDATE os_scheduled_tasks SET last_status='paused', status='paused' WHERE id=$1`, [RS])
    await c.query(`UPDATE os_scheduled_tasks
                      SET last_status = NULL, next_run_at = $2,
                          claimed_by_tab_id = NULL, claimed_at = NULL, updated_at = NOW()
                    WHERE id = $1`, [RS, nextIso])
    const rs = (await c.query('SELECT last_status,claimed_by_tab_id FROM os_scheduled_tasks WHERE id=$1', [RS])).rows[0]
    ok(rs && rs.last_status === null && !rs.claimed_by_tab_id,
       'C9. schedule_resume clears the conductor claim too, so a resumed row is not silently re-suppressed on its next fire')
    ok(/claimed_by_tab_id = NULL, claimed_at = NULL/.test(scheduler.schedule_resume.toString()),
       'C10. that clear is in the SHIPPED schedule_resume, not just in this probe')
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
