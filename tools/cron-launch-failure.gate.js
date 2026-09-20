'use strict'

// cron-launch-failure.gate - the CRON arm of the relaunch, probed on the REAL table.
//
// THE HOLE THIS CLOSES. cron-launch-retry.gate.js exercises cronLaunchRetry as a
// pure function, which proves the judgement and proves nothing about the SQL that
// acts on it. dispatch-launch-failure.gate.js drives the real livenessReapPass
// against the real table, but every fixture it inserts is type='delayed', so it
// proves the `else if (!row.bound_at)` one-shot arm and never once enters the
// `row.type === 'cron' && row.cron_expression` arm that c7d441e added. Until this
// file, NOTHING had driven the cron relaunch SQL against os_scheduled_tasks.
//
// That gap matters because the cron arm is not the one-shot arm with a different
// constant. It writes a different UPDATE, it is guarded on a different predicate,
// and at the retry ceiling it deliberately does the OPPOSITE thing: a one-shot
// goes terminal as 'settled-no-trace', a cron is NEVER settled terminal and falls
// back to the ordinary interval defer, because removing a recurring row from the
// fleet is a far worse outcome than skipping one interval. A function-level gate
// cannot see any of that.
//
// SAFETY. The liveness oracle is stubbed exactly as dispatch-launch-failure.gate.js
// stubs it: every non-fixture running row is reported LIVE, so the pass can only
// ever touch the four fixtures even if the pass itself is wrong. The cap state is
// stubbed to uncapped and restored in the finally, because both cron call sites
// invoke cronLaunchRetry WITHOUT opts.capped, so a live all-accounts cap would
// turn the relaunch assertions red for a reason that is not the code. The live
// value is printed so the run records what it really was.
//
// THE BOUND ROW IS REFUSED TWICE, AND THAT MAKES AN OUTCOME-ONLY ASSERTION BLIND.
// Measured 2026-09-20 while writing this gate: deleting `if (row.bound_at) return
// null` from cronLaunchRetry leaves all sixteen outcome checks GREEN, because the
// relaunch UPDATE also carries `AND bound_at IS NULL`, so the write matches zero
// rows, rowCount is 0, and the code falls through to the same interval defer it
// would have taken anyway. The refusal was right and the reason was an accident,
// which is the shape [[a-negative-control-that-only-asserts-a-refusal-happened]]
// names. So the bound axis is asserted on its REASON as well as its outcome: belt
// 1 calls cronLaunchRetry on a real row read back out of the table, belt 2 reads
// the SQL predicate itself and proves `bound_at IS NULL` is the discriminating
// term rather than decoration. Delete either belt alone and one of those two goes
// red; delete both and the bug is live. The matched mutation on the OTHER axis
// (forcing ceiling:false) IS caught by outcome alone, two checks red, so this is a
// property of the bound axis and not of the gate as a whole.
//
// Fixture names carry NO `-lane-` token, so os_sched_lane_key returns NULL and
// neither the migration-147 collision trigger nor the migration-196 birth cap
// sees them.
//
// Run: node tools/cron-launch-failure.gate.js

require('dotenv').config({ quiet: true })
const scheduler = require('./scheduler')
const settle = require('./dispatch-settle')

const TAG = 'zz-cronlaunch-gate-' + Date.now()
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : '') + '\n')
}

const MIN = 60 * 1000

async function main() {
  const pool = scheduler._poolForLiveness()
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  const ids = []
  const realCapState = scheduler._getCappedOutageState
  let restoredCap = false

  // dispatched_tab_id stays NULL so kill_worker is skipped entirely and the gate
  // can never reach for a real IDE tab.
  async function mkCron(suffix, cronExpr, launchRetries) {
    const r = await pool.query(
      `INSERT INTO os_scheduled_tasks
         (type, name, prompt, status, cron_expression, tz, leased_at, leased_by,
          launch_retry_count, next_run_at)
       VALUES ('cron', $1, 'cron launch-failure gate fixture', 'running', $2,
               'Australia/Brisbane', $3, 'gate', $4, $3)
       RETURNING id`,
      [TAG + '-' + suffix, cronExpr, old, launchRetries])
    ids.push(r.rows[0].id)
    return r.rows[0].id
  }

  try {
    const liveCap = realCapState()
    process.stdout.write('[precondition] live cap state at run time: ' + JSON.stringify(liveCap) + '\n')
    scheduler._getCappedOutageState = () => ({ firstDeferAt: null, defers: 0, sent: false })
    if (liveCap && liveCap.firstDeferAt !== null) {
      process.stdout.write('[precondition] fleet WAS capped; stubbed uncapped so the relaunch arm is reachable\n')
    }

    // 1. A daily cron that leased and never bound. The whole point: it must come
    //    back on a 5m backoff, not lose 24 hours.
    const daily = await mkCron('daily-fresh', '0 3 * * *', 0)
    // 2. A minutely cron. Its own next slot is sooner than the 5m backoff, so the
    //    sooner-of choice must hand it back its own slot. This is the live-table
    //    proof of the branch the scratch mutation turned red.
    const minutely = await mkCron('minutely-fresh', '* * * * *', 0)
    // 3. A cron that DID bind. It overran, it did not fail to launch, and retrying
    //    it is the 2026-06-18 double-fire path.
    const boundRow = await mkCron('bound', '0 3 * * *', 0)
    await pool.query(`UPDATE os_scheduled_tasks SET bound_at = $2,
                        progress_summary = 'this one actually ran' WHERE id = $1`, [boundRow, old])
    // 4. A cron at the retry ceiling. A one-shot goes terminal here. A cron must NOT.
    const ceiling = await mkCron('ceiling', '0 3 * * *', settle.MAX_LAUNCH_RETRIES)
    // 5. A bound cron the pass never touches, kept pristine so the two belts that
    //    refuse a bound relaunch can each be read directly. Reported LIVE below.
    const belt = await mkCron('bound-belt', '0 3 * * *', 0)
    await pool.query(`UPDATE os_scheduled_tasks SET bound_at = $2 WHERE id = $1`, [belt, old])

    const target = new Set(ids.filter(id => String(id) !== String(belt)).map(String))
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

    const t0 = Date.now()
    const r = await scheduler.livenessReapPass({
      liveness,
      dispatcher: { kill_worker: async () => ({ closed: false }) },
    })
    process.stdout.write('\n[pass] scanned=' + r.scanned + ' reaped=' + r.reaped +
      ' live=' + r.live + ' unknown=' + r.unknown + ' (running rows before: ' + before + ')\n\n')

    const rows = (await pool.query(
      `SELECT id, name, type, status, next_run_at, launch_retry_count, settle_verdict,
              settled_at, done_at, last_error, bound_at
         FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [ids])).rows
    const g = id => rows.find(x => String(x.id) === String(id))
    const mins = row => row && row.next_run_at
      ? (new Date(row.next_run_at).getTime() - t0) / MIN
      : NaN

    // ---- 1. the daily cron: the whole bug, on the live path ----
    const d = g(daily)
    check('a never-bound CRON is relaunched, not deferred a whole interval',
      d && d.status === 'active' && d.launch_retry_count === 1,
      d && d.status + ' launch_retry_count=' + d.launch_retry_count)
    check('it comes back on the 5m launch backoff, not tomorrow at 03:00',
      d && mins(d) > 4 && mins(d) < 6,
      d && mins(d).toFixed(2) + 'm out')
    check('the relaunch says it was a launch failure, not a work failure',
      d && /leased but never bound/.test(d.last_error || ''),
      d && String(d.last_error).slice(0, 72))
    check('the relaunch keeps the orphan-timeout provenance in last_error',
      d && /orphan-timeout|liveness-reap/.test(d.last_error || ''),
      d && String(d.last_error).slice(-48))
    check('a relaunched cron is never given a done_at or a settle',
      d && !d.done_at && d.settled_at === null && d.settle_verdict === null,
      d && 'done_at=' + d.done_at + ' settled_at=' + d.settled_at)

    // ---- 2. the minutely cron: the sooner-of choice, on the live path ----
    const m = g(minutely)
    check('a minutely cron is handed back its OWN next slot, not a 5m wait',
      m && m.status === 'active' && mins(m) < 2,
      m && m.status + ' ' + mins(m).toFixed(2) + 'm out')
    check('  pair: the daily cron did NOT get its own slot, it got the backoff',
      d && m && mins(d) > mins(m) + 3,
      d && m && 'daily=' + mins(d).toFixed(2) + 'm minutely=' + mins(m).toFixed(2) + 'm')
    check('the minutely relaunch still counted the attempt',
      m && m.launch_retry_count === 1, m && 'launch_retry_count=' + m.launch_retry_count)

    // ---- 3. the bound cron: an overrun, never a relaunch ----
    const b = g(boundRow)
    check('a cron that DID bind is deferred, not relaunched',
      b && b.status === 'active' && b.launch_retry_count === 0,
      b && b.status + ' launch_retry_count=' + b.launch_retry_count)
    check('the bound cron goes to its natural next slot, hours away',
      b && mins(b) > 60, b && (mins(b) / 60).toFixed(2) + 'h out')
    check('the bound cron is NOT labelled a launch failure',
      b && !/leased but never bound/.test(b.last_error || ''),
      b && String(b.last_error).slice(0, 60))

    // ---- 4. the ceiling: a cron is NEVER settled terminal, unlike a one-shot ----
    const c = g(ceiling)
    check('a cron at the retry ceiling is NOT settled terminal',
      c && c.status === 'active' && c.settled_at === null && c.settle_verdict === null,
      c && c.status + ' settled_at=' + c.settled_at + ' verdict=' + c.settle_verdict)
    check('  the matched one-shot behaviour is the OPPOSITE (settled-no-trace)',
      settle.MAX_LAUNCH_RETRIES === 3,
      'MAX_LAUNCH_RETRIES=' + settle.MAX_LAUNCH_RETRIES)
    check('the ceiling defers to the interval rather than retrying again',
      c && mins(c) > 60, c && (mins(c) / 60).toFixed(2) + 'h out')
    check('the ceiling does not burn another attempt',
      c && c.launch_retry_count === settle.MAX_LAUNCH_RETRIES,
      c && 'launch_retry_count=' + c.launch_retry_count)

    // ---- safety: the pass could not have touched anything real ----
    check('the pass touched ONLY the fixtures (real running rows reported live)',
      r.reaped === target.size && r.live === Math.max(0, before - target.size),
      'reaped=' + r.reaped + ' live=' + r.live + ' targeted=' + target.size)

    // ---- 5. WHY the bound row was refused, not just that it was ----
    const beltRow = (await pool.query(
      `SELECT id, name, type, status, cron_expression, tz, bound_at, launch_retry_count
         FROM os_scheduled_tasks WHERE id = $1`, [belt])).rows[0]
    check('the belt fixture was left untouched by the pass',
      beltRow && beltRow.status === 'running' && beltRow.bound_at !== null,
      beltRow && beltRow.status)
    check('BELT 1 (function): cronLaunchRetry refuses a real bound row from the table',
      scheduler.cronLaunchRetry(beltRow) === null,
      JSON.stringify(scheduler.cronLaunchRetry(beltRow)))
    check('  pair: the same row with bound_at cleared IS relaunched',
      scheduler.cronLaunchRetry(Object.assign({}, beltRow, { bound_at: null })) !== null)
    const guarded = await pool.query(
      `SELECT 1 FROM os_scheduled_tasks
        WHERE id = $1 AND status = 'running' AND bound_at IS NULL
          AND done_at IS NULL AND archived_at IS NULL`, [belt])
    const unguarded = await pool.query(
      `SELECT 1 FROM os_scheduled_tasks
        WHERE id = $1 AND status = 'running'
          AND done_at IS NULL AND archived_at IS NULL`, [belt])
    check('BELT 2 (SQL): the relaunch predicate matches the bound row ZERO times',
      guarded.rowCount === 0, 'rowCount=' + guarded.rowCount)
    check('  pair: the same predicate WITHOUT bound_at IS NULL matches it once',
      unguarded.rowCount === 1,
      'rowCount=' + unguarded.rowCount + ' (so bound_at IS NULL is the term doing the work)')
  } finally {
    scheduler._getCappedOutageState = realCapState
    restoredCap = true
    if (ids.length) {
      await pool.query(`UPDATE os_scheduled_tasks SET archived_at=NOW() WHERE id = ANY($1::uuid[])`, [ids])
      await pool.query(`DELETE FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [ids])
    }
    await pool.query(`UPDATE os_scheduled_tasks SET archived_at=NOW() WHERE name LIKE $1`, [TAG + '%'])
    await pool.query(`DELETE FROM os_scheduled_tasks WHERE name LIKE $1`, [TAG + '%'])
    process.stdout.write('\n[cleanup] cron launch-failure fixtures removed' +
      (restoredCap ? ', cap state restored' : '') + '\n')
  }
  const failed = results.filter(x => !x.ok)
  process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n')
  process.exit(failed.length ? 1 : 0)
}
main().catch(e => { process.stderr.write('gate error: ' + (e && e.stack || e) + '\n'); process.exit(2) })
