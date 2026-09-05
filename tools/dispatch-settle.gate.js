'use strict'

// dispatch-settle.gate - the discriminating probe for the evidence-settle reconciler.
//
// It runs the REAL settleReconcilerPass against the REAL os_scheduled_tasks table,
// not a copy of the logic against a fake, because a gate that exercises a
// reimplementation proves something about the reimplementation.
//
// THE NEGATIVE CONTROL IS THE POINT. A settle that has never been observed
// refusing a live worker is not evidence that it can. So the control row is not a
// stub: it carries THIS PROCESS'S OWN dispatched tab id, whose transcript the
// Claude Code harness is appending to while the gate runs. worker-liveness reads
// that file's mtime with no cooperation from anyone, so the control is alive in
// exactly the way a real worker is alive, and the refusal is a real refusal.
// Pass EOS_GATE_LIVE_TAB=<tab_id> to name it; without one, that case is reported
// SKIPPED rather than passed, because a control you did not run is not a control.
//
// Also gated, because they are the structural guarantee and not a nicety:
//   * a settle that tries to write done_at must RAISE (migration 168 trigger a)
//   * a real worker report landing after a settle must WITHDRAW it (trigger b)
//   * a settled row must be distinguishable from a real completion by query alone
//
// Run: node tools/dispatch-settle.gate.js
// Exits 0 only if every case passes. Cleans up every row it created.

require('dotenv').config({ quiet: true })
const settle = require('./dispatch-settle')

const LIVE_TAB = process.env.EOS_GATE_LIVE_TAB || null
const TAG = 'zz-settle-gate-' + Date.now()
const LANE = 'cowork.zzsettlegate-lane-Z9'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : '') + '\n')
}

async function main() {
  const scheduler = require('./scheduler')
  const pool = scheduler._poolForLiveness()
  const ids = {}
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()

  async function mk(key, fields) {
    const cols = Object.keys(fields)
    const r = await pool.query(
      `INSERT INTO os_scheduled_tasks (type, name, prompt, status, ${cols.join(', ')})
       VALUES ('delayed', $1, 'gate fixture', 'orphaned', ${cols.map((_, i) => '$' + (i + 2)).join(', ')})
       RETURNING id`,
      [TAG + '-' + key, ...cols.map(c => fields[c])]
    )
    ids[key] = r.rows[0].id
    return r.rows[0].id
  }

  try {
    // A. bound, left a trace, dead. The 68-row class.
    await mk('A', { leased_at: fiveHoursAgo, bound_at: fiveHoursAgo,
      dispatched_tab_id: 'tab_17000000000_deadbee1',
      progress_summary: 'landed the migration, was mid-way through the reconciler' })

    // B. THE NEGATIVE CONTROL. Bound and genuinely alive: this process's own tab.
    if (LIVE_TAB) {
      await mk('B', { leased_at: fiveHoursAgo, bound_at: fiveHoursAgo,
        dispatched_tab_id: LIVE_TAB,
        progress_summary: 'this worker is still running and must not be settled' })
    }

    // C. never bound. The 89-row class: the Mac never opened a tab.
    await mk('C', { leased_at: fiveHoursAgo, dispatched_tab_id: 'tab_17000000000_deadbee3' })

    // D. bound and left nothing anywhere.
    await mk('D', { leased_at: fiveHoursAgo, bound_at: fiveHoursAgo,
      dispatched_tab_id: 'tab_17000000000_deadbee4' })

    // E + its successor, on a lane nothing else holds: the finished-and-died signal.
    const eId = await mk('E', { leased_at: fiveHoursAgo, bound_at: fiveHoursAgo,
      dispatched_tab_id: 'tab_17000000000_deadbee5',
      progress_summary: 'shipped the thing, arming the verifier' })
    await pool.query(
      `UPDATE os_scheduled_tasks SET name = $2, last_run_at = NOW() WHERE id = $1`,
      [eId, LANE + '-gate-primary'])
    await pool.query(
      `INSERT INTO os_scheduled_tasks (type, name, prompt, status, created_at)
       VALUES ('delayed', $1, 'gate fixture successor', 'cancelled', NOW() - interval '1 hour')`,
      [LANE + '-gate-successor'])

    const only = Object.values(ids)
    const r = await settle.settleReconcilerPass({ scheduler, only_ids: only, limit: 50 })
    process.stdout.write('\n[pass] scanned=' + r.scanned + ' settled=' + r.settled +
      ' refused_live=' + r.skipped_live + '\n\n')

    const rows = await pool.query(
      `SELECT id, name, status, settle_verdict, done_at, settled_at, settle_evidence
         FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [only])
    const by = {}
    for (const [k, v] of Object.entries(ids)) by[k] = rows.rows.find(x => String(x.id) === String(v))

    check('A bound-with-trace settles to settled-with-trace',
      by.A && by.A.status === 'settled-with-trace', by.A && by.A.status + '/' + by.A.settle_verdict)
    check('A cites the trace it read in settle_evidence',
      by.A && by.A.settle_evidence && by.A.settle_evidence.progress_summary,
      by.A && by.A.settle_evidence && String(by.A.settle_evidence.progress_summary).slice(0, 40))
    check('A never gets a synthesized done_at', by.A && by.A.done_at === null)

    if (LIVE_TAB) {
      check('NEGATIVE CONTROL: live worker is REFUSED, row untouched',
        by.B && by.B.status === 'orphaned' && by.B.settled_at === null,
        by.B && by.B.status + ' settled_at=' + by.B.settled_at)
    } else {
      check('NEGATIVE CONTROL: live worker is REFUSED (SKIPPED, no EOS_GATE_LIVE_TAB)', false,
        'no live tab supplied, so the control did not run')
    }

    check('C never-bound settles as launch-failure, not as work failure',
      by.C && by.C.settle_verdict === 'launch-failure' && by.C.status === 'settled-no-trace',
      by.C && by.C.status + '/' + by.C.settle_verdict)
    check('D no-trace settles as settled-no-trace (stays alarming)',
      by.D && by.D.status === 'settled-no-trace' && by.D.settle_verdict === 'no-trace',
      by.D && by.D.status + '/' + by.D.settle_verdict)
    check('E with a successor on its lane reads finished-and-died',
      by.E && by.E.settle_verdict === 'finished-and-died',
      by.E && by.E.settle_verdict + ' successors=' +
        (by.E.settle_evidence && by.E.settle_evidence.successor && by.E.settle_evidence.successor.found))

    // MUST FAIL, one: the reconciler fabricating a completion in ONE statement.
    // Row F is deliberately fresh and unsettled, because running this against an
    // already-settled row tests the withdraw clause instead and reads as a pass
    // for the wrong reason (it did on the first gate run, 2026-09-05).
    const fId = await mk('F', { leased_at: fiveHoursAgo, bound_at: fiveHoursAgo,
      dispatched_tab_id: 'tab_17000000000_deadbee6' })
    let raised = null
    try {
      await pool.query(
        `UPDATE os_scheduled_tasks SET settled_at = NOW(), settle_verdict = 'finished-and-died',
                status = 'settled-with-trace', done_at = NOW(), done_status = 'success'
          WHERE id = $1`, [fId])
    } catch (e) { raised = e.message }
    check('MUST FAIL: a settle writing done_at in ONE statement RAISES',
      raised && /may not write done_at/.test(raised), raised ? raised.split('\n')[0].slice(0, 90) : 'NO ERROR RAISED')

    // MUST FAIL, two: the same fabrication split across two statements, which is
    // how it would actually get past a single-statement trigger. The CHECK is what
    // stops this, so it holds even if the trigger is dropped.
    let raised2 = null
    await pool.query(`UPDATE os_scheduled_tasks SET settled_at = NOW(),
                        settle_verdict = 'cannot-tell', status = 'settled-with-trace'
                       WHERE id = $1`, [fId])
    try {
      await pool.query(`ALTER TABLE os_scheduled_tasks DISABLE TRIGGER trg_os_sched_settle_never_fabricates_completion`)
      await pool.query(`UPDATE os_scheduled_tasks SET done_at = NOW(), done_status = 'success' WHERE id = $1`, [fId])
    } catch (e) { raised2 = e.message }
    finally {
      try { await pool.query(`ALTER TABLE os_scheduled_tasks ENABLE TRIGGER trg_os_sched_settle_never_fabricates_completion`) } catch (_e) {}
    }
    check('MUST FAIL: settled_at + done_at both set is REFUSED even with the trigger off',
      raised2 && /settle_xor_done/.test(raised2), raised2 ? raised2.split('\n')[0].slice(0, 90) : 'NO ERROR RAISED')

    // A real worker report after a settle withdraws the settle (pre-mortem 3).
    await pool.query(
      `UPDATE os_scheduled_tasks SET done_at = NOW(), done_status = 'success',
              done_summary = 'the worker was slow, not dead' WHERE id = $1`, [ids.A])
    const a2 = (await pool.query(
      `SELECT status, settled_at, settle_verdict, done_at, settle_evidence
         FROM os_scheduled_tasks WHERE id = $1`, [ids.A])).rows[0]
    check('a late worker report WITHDRAWS the settle (real beats inferred)',
      a2.settled_at === null && a2.settle_verdict === null && a2.done_at !== null,
      'status=' + a2.status + ' settled_at=' + a2.settled_at)
    check('the withdrawal is recorded, not silent',
      a2.settle_evidence && a2.settle_evidence.superseded_by_worker_signal === true,
      JSON.stringify(a2.settle_evidence && a2.settle_evidence.withdrawn_from_status))

    // Distinguishable by query alone.
    const d = (await pool.query(
      `SELECT count(*) FILTER (WHERE done_at IS NOT NULL) AS real_completions,
              count(*) FILTER (WHERE settled_at IS NOT NULL AND done_at IS NULL) AS inferred,
              count(*) FILTER (WHERE settled_at IS NOT NULL AND done_at IS NOT NULL) AS both
         FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [Object.values(ids)])).rows[0]
    check('a settle is distinguishable from a real completion by query alone',
      Number(d.real_completions) === 1 && Number(d.inferred) >= 3 && Number(d.both) === 0,
      'real=' + d.real_completions + ' inferred=' + d.inferred + ' both=' + d.both)

    // C-i decision table, pure.
    const D0 = settle.launchFailureDecision({ launch_retry_count: 0 }, {})
    const Dcap = settle.launchFailureDecision({ launch_retry_count: 0 }, { capped: true })
    const Dlane = settle.launchFailureDecision({ launch_retry_count: 0 }, { laneHeld: true, laneKey: 'X1' })
    const Dceil = settle.launchFailureDecision({ launch_retry_count: settle.MAX_LAUNCH_RETRIES }, {})
    check('C-i relaunches a fresh launch failure', D0.action === 'relaunch', D0.action + ' at ' + D0.next_run_at)
    check('C-i REFUSES to relaunch while all accounts are capped', Dcap.action === 'defer', Dcap.reason)
    check('C-i REFUSES to relaunch into a held lane (no supersede)', Dlane.action === 'defer', Dlane.reason)
    check('C-i escalates at the ceiling instead of looping', Dceil.action === 'escalate', Dceil.reason)
    check('C-i backoff grows', settle.launchBackoffMs(2) > settle.launchBackoffMs(0),
      settle.launchBackoffMs(0) / 60000 + 'm -> ' + settle.launchBackoffMs(2) / 60000 + 'm')
  } finally {
    const all = Object.values(ids)
    if (all.length) {
      await pool.query(`UPDATE os_scheduled_tasks SET archived_at = NOW() WHERE id = ANY($1::uuid[])`, [all])
      await pool.query(`DELETE FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [all])
    }
    await pool.query(`UPDATE os_scheduled_tasks SET archived_at = NOW() WHERE name LIKE $1 OR name LIKE $2`,
      [TAG + '%', LANE + '%'])
    await pool.query(`DELETE FROM os_scheduled_tasks WHERE name LIKE $1 OR name LIKE $2`,
      [TAG + '%', LANE + '%'])
    process.stdout.write('\n[cleanup] gate fixtures removed\n')
  }

  const failed = results.filter(r => !r.ok)
  process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' gate checks passed\n')
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => { process.stderr.write('gate error: ' + (e && e.stack || e) + '\n'); process.exit(2) })
