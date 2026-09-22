'use strict'

// cron-reclaim-last-run-at.gate - a RECLAIM IS NOT A RUN, probed on the REAL table.
//
// THE DEFECT THIS LOCKS DOWN. Every cron reclaim arm in scheduler.js used to write
// last_run_at = NOW(). last_run_at has exactly one honest meaning, the last time the
// row actually fired, and run_count (written only by markComplete) is its only
// companion. So a cron whose tab never opened produced nothing and still advanced
// the timestamp, and every surface read green off a fire that never started.
//
// The second half is the one that cost coverage. cronAlreadyRanThisPeriod compares
// last_run_at against the current cron boundary and has NO launch_retry_count
// carve-out. The relaunch arm sets next_run_at to a short backoff INSIDE the same
// period, so the same UPDATE that armed the retry also wrote the value that made
// the re-entry guard refuse it on the very next lease. Measured on
// secrets-daily-audit (23fddbac) 2026-09-21: worker tab_1790017295261_87ec82e4
// registered 19:01:35.296Z and never bound; the sweep relaunched it for
// 20:06:47.741Z at 20:01:47.757981Z; leaseDueRows then logged 're-entry guard
// skipped ... already ran this period; next_run_at -> 2026-09-22T19:00:00.000Z'.
// run_count stayed at 49 and a day of security sweep was lost. c7d441e's relaunch
// fix was dead on arrival for this reason, on the first cron that exercised it.
//
// WHY THE PAYOFF CHECK IS THE LOAD-BEARING ONE. Asserting only "last_run_at did not
// move" would pass against a build that never reached the UPDATE at all, which is
// the shape [[a-negative-control-that-only-asserts-a-refusal-happened]] names. So
// this gate also asserts the CONSEQUENCE: after the reclaim,
// cronAlreadyRanThisPeriod is false on the row read back out of the table, and TRUE
// on the same row with last_run_at forced to now. That pair proves the stamp was
// the term defeating the retry, not a coincidence of the fixture.
//
// SAFETY. Only livenessReapPass is driven live, because it accepts a stubbed
// liveness oracle: every non-fixture running row is reported LIVE, so the pass can
// only ever touch the fixtures even if the pass itself is wrong. staleLeaseRecovery
// takes no opts and would consult the real coord oracle against real running rows,
// so it is NOT driven here; its two cron arms are asserted as source belts instead,
// on the same file the daemon executes. Cap state is stubbed uncapped and restored
// in the finally, because both cron call sites invoke cronLaunchRetry without
// opts.capped.
//
// Fixture names carry NO `-lane-` token, so os_sched_lane_key returns NULL and
// neither the migration-147 collision trigger nor the migration-196 birth cap sees
// them.
//
// Run: node tools/cron-reclaim-last-run-at.gate.js

require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')
const scheduler = require('./scheduler')
const settle = require('./dispatch-settle')

const TAG = 'zz-reclaim-lastrun-gate-' + Date.now()
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : '') + '\n')
}

// A last_run_at far enough back that the previous daily 03:00 boundary is strictly
// after it, so cronAlreadyRanThisPeriod is unambiguously false on a preserved value.
const PRIOR_RUN = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()

async function main() {
  const pool = scheduler._poolForLiveness()
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  const ids = []
  const realCapState = scheduler._getCappedOutageState

  async function mkCron(suffix, cronExpr, launchRetries) {
    const r = await pool.query(
      `INSERT INTO os_scheduled_tasks
         (type, name, prompt, status, cron_expression, tz, leased_at, leased_by,
          launch_retry_count, next_run_at, last_run_at, run_count)
       VALUES ('cron', $1, 'cron reclaim last_run_at gate fixture', 'running', $2,
               'Australia/Brisbane', $3, 'gate', $4, $3, $5, 49)
       RETURNING id`,
      [TAG + '-' + suffix, cronExpr, old, launchRetries, PRIOR_RUN])
    ids.push(r.rows[0].id)
    return r.rows[0].id
  }

  try {
    const liveCap = realCapState()
    process.stdout.write('[precondition] live cap state at run time: ' + JSON.stringify(liveCap) + '\n')
    scheduler._getCappedOutageState = () => ({ firstDeferAt: null, defers: 0, sent: false })

    // 1. never bound, fresh: takes the RELAUNCH arm.
    const relaunch = await mkCron('relaunch', '0 3 * * *', 0)
    // 2. never bound, at the retry ceiling: falls through to the cron DEFER arm.
    //    This is the arm guarded by the CASE rather than by bound_at IS NULL.
    const ceiling = await mkCron('ceiling', '0 3 * * *', settle.MAX_LAUNCH_RETRIES)
    // 3. DID bind, overran: the negative control. A row that really ran must still
    //    advance last_run_at, or the fix has simply disabled the column.
    const bound = await mkCron('bound', '0 3 * * *', 0)
    await pool.query(`UPDATE os_scheduled_tasks SET bound_at = $2 WHERE id = $1`, [bound, old])

    // 4. THE ARM THAT ACTUALLY FIRED ON 23fddbac. staleLeaseRecovery branch 3 reclaims
    //    a cron whose lease is older than RUNNING_CRON_ORPHAN_MS (30m). It is deliberately
    //    left OUT of `target`, so the liveness stub reports it live and livenessReapPass
    //    cannot touch it; staleLeaseRecovery is then driven against it separately below.
    const sweepFixture = await mkCron('stalelease', '0 3 * * *', 0)

    const target = new Set(ids.filter(id => String(id) !== String(sweepFixture)).map(String))
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
      `SELECT id, name, type, status, cron_expression, tz, last_run_at, next_run_at,
              run_count, launch_retry_count, bound_at, last_error
         FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [ids])).rows
    const g = id => rows.find(x => String(x.id) === String(id))
    const same = row => row && new Date(row.last_run_at).getTime() === new Date(PRIOR_RUN).getTime()

    // ---- 1. the relaunch arm: the row must not claim to have run ----
    const a = g(relaunch)
    check('RELAUNCH arm: a never-bound cron is relaunched',
      a && a.status === 'active' && a.launch_retry_count === 1,
      a && a.status + ' launch_retry_count=' + a.launch_retry_count)
    check('RELAUNCH arm: last_run_at did NOT advance off a fire that never started',
      same(a), a && 'last_run_at=' + a.last_run_at)
    check('RELAUNCH arm: run_count is untouched, so the two agree with each other',
      a && a.run_count === 49, a && 'run_count=' + a.run_count)

    // ---- 2. the ceiling defer arm: guarded by the CASE, not by bound_at IS NULL ----
    const c = g(ceiling)
    check('DEFER arm: a never-bound cron at the ceiling defers to its interval',
      c && c.status === 'active' && c.launch_retry_count === settle.MAX_LAUNCH_RETRIES,
      c && c.status + ' launch_retry_count=' + c.launch_retry_count)
    check('DEFER arm: last_run_at did NOT advance either (the CASE covers this arm)',
      same(c), c && 'last_run_at=' + c.last_run_at)

    // ---- 3. the negative control: a row that really ran STILL advances ----
    const b = g(bound)
    check('CONTROL: a cron that DID bind still advances last_run_at',
      b && new Date(b.last_run_at).getTime() > new Date(PRIOR_RUN).getTime(),
      b && 'last_run_at=' + b.last_run_at)
    check('  pair: so the fix discriminates on bound_at rather than disabling the column',
      same(a) && b && new Date(b.last_run_at).getTime() > new Date(PRIOR_RUN).getTime(),
      'unbound preserved=' + same(a) + ' bound advanced=' +
        (b && new Date(b.last_run_at).getTime() > new Date(PRIOR_RUN).getTime()))

    // ---- 4. THE PAYOFF. The relaunch this arm just armed must survive the lease ----
    check('PAYOFF: cronAlreadyRanThisPeriod is FALSE on the relaunched row, so the ' +
          're-entry guard lets the retry through',
      a && scheduler.cronAlreadyRanThisPeriod(a, new Date()) === false,
      a && 'last_run_at=' + a.last_run_at)
    check('  pair: the SAME row with last_run_at forced to now reads TRUE, which is ' +
          'the stamp that used to kill the retry',
      a && scheduler.cronAlreadyRanThisPeriod(
        Object.assign({}, a, { last_run_at: new Date().toISOString() }), new Date()) === true)
    check('  and the bound control DOES read TRUE, as a genuinely-ran row should',
      b && scheduler.cronAlreadyRanThisPeriod(b, new Date()) === true,
      b && 'last_run_at=' + b.last_run_at)

    // ---- 5. safety ----
    check('the pass touched ONLY the fixtures (real running rows reported live)',
      r.reaped === target.size && r.live === Math.max(0, before - target.size),
      'reaped=' + r.reaped + ' live=' + r.live + ' targeted=' + target.size)

    // ---- 6. THE ARM THAT FIRED, driven live ----
    // Safe to drive here and only here: staleLeaseRecovery already runs on a 60s timer
    // inside the daemon, so calling it once more is not a novel action. Its branch-3
    // orphan query selects cron rows leased more than 30m ago and non-cron rows leased
    // more than 6h ago. Every real running row was probed immediately before this gate
    // was written and none qualified. It takes no opts, so it uses the real coord oracle
    // and the real dispatcher; the fixture carries dispatched_tab_id NULL so kill_worker
    // is skipped entirely and it can never reach for an IDE tab.
    await scheduler.staleLeaseRecovery()
    const sw = (await pool.query(
      // `type` is load-bearing and was omitted in the first draft of this gate.
      // cronAlreadyRanThisPeriod returns false on `row.type !== 'cron'` BEFORE it ever
      // looks at last_run_at, so a row read back without it made the PAYOFF check pass
      // for a reason that had nothing to do with the fix. The paired control below is
      // what caught that, which is the whole argument for pairing a refusal with its
      // reason: [[a-negative-control-that-only-asserts-a-refusal-happened]].
      `SELECT id, name, type, cron_expression, tz, status, last_run_at, next_run_at, run_count,
              launch_retry_count, bound_at, last_error
         FROM os_scheduled_tasks WHERE id = $1`, [sweepFixture])).rows[0]
    check('STALELEASE arm: the 23fddbac path relaunches a never-bound cron',
      sw && sw.status === 'active' && sw.launch_retry_count === 1,
      sw && sw.status + ' launch_retry_count=' + sw.launch_retry_count)
    check('STALELEASE arm: last_run_at did NOT advance on the arm that lost the 09-21 sweep',
      sw && new Date(sw.last_run_at).getTime() === new Date(PRIOR_RUN).getTime(),
      sw && 'last_run_at=' + sw.last_run_at)
    check('STALELEASE arm: PAYOFF, the re-entry guard now lets its own relaunch through',
      sw && scheduler.cronAlreadyRanThisPeriod(sw, new Date()) === false,
      sw && 'next_run_at=' + sw.next_run_at)
    check('  pair: with last_run_at forced to now the guard refuses it, which is the 09-21 outcome',
      sw && scheduler.cronAlreadyRanThisPeriod(
        Object.assign({}, sw, { last_run_at: new Date().toISOString() }), new Date()) === true)

    // ---- 7. SOURCE BELT for staleLeaseRecovery ----
    // staleLeaseRecovery takes no opts, so driving it would consult the real coord
    // oracle against real running rows. Its two cron arms are asserted on the file
    // the daemon executes instead. This is the arm that actually fired on 23fddbac.
    const src = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8')
    const body = src.slice(src.indexOf('exports.staleLeaseRecovery'),
                           src.indexOf('exports.livenessReapPass'))
    const cronArms = body.split('cronLaunchRetry').length - 1
    check('BELT: staleLeaseRecovery still carries its cron launch-retry arm',
      cronArms >= 1, 'cronLaunchRetry references=' + cronArms)
    check('BELT: no bare `last_run_at = NOW()` survives in any staleLeaseRecovery CRON arm',
      !/SET status = 'active', retry_count = 0, last_run_at = NOW\(\)/.test(body),
      'bare stamps in cron arms=' + (body.match(/SET status = 'active', retry_count = 0, last_run_at = NOW\(\)/g) || []).length)
    check('BELT: its cron defer arm carries the bound_at CASE',
      /last_run_at = CASE WHEN bound_at IS NULL THEN last_run_at ELSE NOW\(\) END/.test(body))
    check('  pair: the one-shot `orphaned` arm deliberately KEEPS its stamp',
      /SET status = 'orphaned', last_run_at = NOW\(\)/.test(body),
      'one-shot rows go terminal, which is not a green read')

    // ---- 8. markComplete must clear last_error, or the reclaim marker is untrustworthy ----
    const mc = src.slice(src.indexOf('run_count = run_count + 1, last_result = $2'))
    check('markComplete clears last_error on a real completion',
      /run_count = run_count \+ 1, last_result = \$2, last_error = NULL/.test(src),
      'else a successful fire carries the previous fire\'s error forever')
  } finally {
    scheduler._getCappedOutageState = realCapState
    if (ids.length) {
      await pool.query(`UPDATE os_scheduled_tasks SET archived_at=NOW() WHERE id = ANY($1::uuid[])`, [ids])
      await pool.query(`DELETE FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`, [ids])
    }
    await pool.query(`UPDATE os_scheduled_tasks SET archived_at=NOW() WHERE name LIKE $1`, [TAG + '%'])
    await pool.query(`DELETE FROM os_scheduled_tasks WHERE name LIKE $1`, [TAG + '%'])
    process.stdout.write('\n[cleanup] reclaim last_run_at fixtures removed, cap state restored\n')
  }
  const failed = results.filter(x => !x.ok)
  process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n')
  process.exit(failed.length ? 1 : 0)
}
main().catch(e => { process.stderr.write('gate error: ' + (e && e.stack || e) + '\n'); process.exit(2) })
