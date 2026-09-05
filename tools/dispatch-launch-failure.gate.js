'use strict'

// dispatch-launch-failure.gate - the C-i half, probed on the REAL table.
//
// The settle gate exercises launchFailureDecision as a pure function, which proves
// the judgement and proves nothing about the SQL that acts on it. This drives the
// REAL livenessReapPass against the REAL os_scheduled_tasks, with the liveness
// oracle stubbed to call exactly one fixture row dead and EVERY other running row
// live. That inversion is the safety property: the pass can only ever touch the
// fixture, so running it against production cannot reap a live worker even if the
// pass is wrong.
//
// Run: node tools/dispatch-launch-failure.gate.js

require('dotenv').config({ quiet: true })
const scheduler = require('./scheduler')
const settle = require('./dispatch-settle')

const TAG = 'zz-launchfail-gate-' + Date.now()
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : '') + '\n')
}

async function main() {
  const pool = scheduler._poolForLiveness()
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  const ids = []

  async function mkRunning(suffix, launchRetries) {
    const r = await pool.query(
      `INSERT INTO os_scheduled_tasks
         (type, name, prompt, status, leased_at, leased_by, dispatched_tab_id, launch_retry_count, next_run_at)
       VALUES ('delayed', $1, 'launch-failure gate fixture', 'running', $2, 'gate',
               'tab_17000000000_1aunchfa', $3, $2)
       RETURNING id`,
      [TAG + '-' + suffix, old, launchRetries])
    ids.push(r.rows[0].id)
    return r.rows[0].id
  }

  try {
    const fresh = await mkRunning('fresh', 0)                              // never bound, 0 attempts
    const atCeiling = await mkRunning('ceiling', settle.MAX_LAUNCH_RETRIES) // never bound, at the ceiling
    // A bound row, so the pass must NOT treat it as a launch failure: it ran.
    const boundRow = await mkRunning('bound', 0)
    await pool.query(`UPDATE os_scheduled_tasks SET bound_at = $2,
                        progress_summary = 'this one actually ran' WHERE id = $1`, [boundRow, old])

    const target = new Set(ids.map(String))
    // Dead for the fixtures ONLY. Everything else running is reported live, so the
    // real pass provably cannot touch a real worker while this gate runs.
    const liveness = {
      probeRows(rows) {
        return rows.map(r => target.has(String(r.id))
          ? { id: r.id, name: r.name, tab_id: r.dispatched_tab_id, verdict: 'dead',
              reason: 'gate fixture', evidence: { gate: true } }
          : { id: r.id, name: r.name, tab_id: r.dispatched_tab_id, verdict: 'live',
              reason: 'gate: not a fixture, reported live so the pass cannot touch it',
              evidence: {} })
      },
    }
    const before = (await pool.query(
      `SELECT count(*)::int n FROM os_scheduled_tasks WHERE status='running' AND archived_at IS NULL`)).rows[0].n

    const r = await scheduler.livenessReapPass({
      liveness,
      dispatcher: { kill_worker: async () => ({ closed: false }) },
    })
    process.stdout.write('\n[pass] scanned=' + r.scanned + ' reaped=' + r.reaped +
      ' live=' + r.live + ' unknown=' + r.unknown + ' (running rows before: ' + before + ')\n\n')

    const rows = (await pool.query(
      `SELECT id, name, status, next_run_at, launch_retry_count, settle_verdict,
              settled_at, last_error, settle_evidence
         FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [ids])).rows
    const g = id => rows.find(x => String(x.id) === String(id))

    const f = g(fresh)
    check('a never-bound row is RELAUNCHED, not buried',
      f && f.status === 'active' && f.launch_retry_count === 1,
      f && f.status + ' launch_retry_count=' + f.launch_retry_count)
    check('the relaunch is scheduled into the future with backoff',
      f && new Date(f.next_run_at).getTime() > Date.now(),
      f && 'next_run_at=' + f.next_run_at)
    check('the relaunch says WHY, not just that it happened',
      f && /launch-failure relaunch/.test(f.last_error || ''), f && String(f.last_error).slice(0, 70))

    const c = g(atCeiling)
    check('at the ceiling it escalates instead of looping forever',
      c && c.status === 'settled-no-trace' && c.settle_verdict === 'launch-failure',
      c && c.status + '/' + c.settle_verdict)
    check('the escalation names the fleet problem, not the row',
      c && c.settle_evidence && /out of launch capacity/.test(c.settle_evidence.note || ''),
      c && c.settle_evidence && String(c.settle_evidence.note).slice(0, 60))
    check('the escalated row is never given a done_at', c && c.settled_at !== null && !c.done_at)

    const b = g(boundRow)
    check('a row that DID bind is not misread as a launch failure',
      b && b.status === 'orphaned' && b.launch_retry_count === 0,
      b && b.status + ' launch_retry_count=' + b.launch_retry_count)

    check('the pass touched ONLY the fixtures (real running rows reported live)',
      r.reaped === ids.length && r.live === Math.max(0, before - ids.length),
      'reaped=' + r.reaped + ' live=' + r.live)
  } finally {
    if (ids.length) {
      await pool.query(`UPDATE os_scheduled_tasks SET archived_at=NOW() WHERE id = ANY($1::uuid[])`, [ids])
      await pool.query(`DELETE FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [ids])
    }
    await pool.query(`UPDATE os_scheduled_tasks SET archived_at=NOW() WHERE name LIKE $1`, [TAG + '%'])
    await pool.query(`DELETE FROM os_scheduled_tasks WHERE name LIKE $1`, [TAG + '%'])
    process.stdout.write('\n[cleanup] launch-failure fixtures removed\n')
  }
  const failed = results.filter(x => !x.ok)
  process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n')
  process.exit(failed.length ? 1 : 0)
}
main().catch(e => { process.stderr.write('gate error: ' + (e && e.stack || e) + '\n'); process.exit(2) })
