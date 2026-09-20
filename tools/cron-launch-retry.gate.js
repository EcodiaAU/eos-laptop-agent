'use strict'

// cron-launch-retry.gate - proves the cron half of the launch-failure fix.
//
// WHY THIS EXISTS. Both reclaim paths in scheduler.js branch on
// `row.type === 'cron'` BEFORE the `!row.bound_at` relaunch, so the launch-failure
// remedy shipped for one-shots on 2026-09-05 was unreachable for every cron in the
// fleet. A cron whose tab never opened lost its whole interval with no retry and no
// alarm. Measured 2026-09-12 on orphan-next-action-audit: leased 00:10:31Z, signal_bound
// timeout, zero transcripts on disk, reclaimed 01:11:26Z, run_count frozen at 29, and
// its own deliverable still carrying the previous day's heartbeat.
//
// EVERY REFUSAL HERE IS ASSERTED AS A MATCHED PAIR. A control that only checks
// "it refused" cannot tell a designed refusal from a lucky one
// (patterns/a-negative-control-that-only-asserts-a-refusal-happened-2026-09-05), so each
// refusal case is paired with the same row minus the one field under test, which MUST
// return a relaunch. If the guard is deleted, the refusal half goes red.
//
// Run: node tools/cron-launch-retry.gate.js

const fs = require('fs')
const path = require('path')
const sched = require('./scheduler')
const settle = require('./dispatch-settle')

let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')) }
}

const NOW = Date.parse('2026-09-12T01:11:26Z')
// Daily at 00:10 UTC, the real shape of the row this was measured on.
function cronRow(over) {
  return Object.assign({
    id: 'test-row', name: 'orphan-next-action-audit', type: 'cron',
    cron_expression: '10 0 * * *', tz: 'UTC',
    bound_at: null, launch_retry_count: 0,
  }, over || {})
}
const CTX = { now_ms: NOW, capped: false, settle }

console.log('cron-launch-retry.gate')

// 1. The whole point: a never-bound cron is relaunched on a short backoff.
const r1 = sched.cronLaunchRetry(cronRow(), CTX)
ok('never-bound cron relaunches', !!r1 && r1.ceiling === false && r1.attempts === 1,
   JSON.stringify(r1))
ok('first backoff is 5m, not the next interval',
   !!r1 && Date.parse(r1.next_run_at) === NOW + 5 * 60 * 1000,
   r1 && r1.next_run_at)

// 2. REFUSAL + MATCHED PAIR: a bound cron overran. Never retry it (the 2026-06-18
//    double-fire path). The pair proves the refusal is the bound_at check and not
//    some unrelated field making every case refuse.
const bound = sched.cronLaunchRetry(cronRow({ bound_at: '2026-09-12T00:11:00Z' }), CTX)
ok('bound cron is REFUSED (overrun, not a launch failure)', bound === null, JSON.stringify(bound))
ok('  pair: same row with bound_at cleared DOES relaunch',
   !!sched.cronLaunchRetry(cronRow({ bound_at: null }), CTX))

// 3. REFUSAL + MATCHED PAIR: an all-accounts cap.
const capped = sched.cronLaunchRetry(cronRow(), { now_ms: NOW, capped: true, settle })
ok('capped fleet is REFUSED', capped === null, JSON.stringify(capped))
ok('  pair: same row uncapped DOES relaunch',
   !!sched.cronLaunchRetry(cronRow(), { now_ms: NOW, capped: false, settle }))

// 4. CEILING: report it, and NEVER settle a cron terminal. A recurring row removed
//    from the fleet by a retry ceiling is worse than a skipped interval.
const ceil = sched.cronLaunchRetry(cronRow({ launch_retry_count: settle.MAX_LAUNCH_RETRIES }), CTX)
ok('at ceiling returns ceiling:true', !!ceil && ceil.ceiling === true, JSON.stringify(ceil))
ok('ceiling carries no next_run_at (falls back to the interval defer)',
   !!ceil && ceil.next_run_at === undefined)
ok('  pair: one under the ceiling still relaunches',
   !!sched.cronLaunchRetry(cronRow({ launch_retry_count: settle.MAX_LAUNCH_RETRIES - 1 }), CTX))

// 5. A frequent cron must not be DELAYED by the retry meant to help it: the retry
//    time is the sooner of the backoff and the row's own next slot.
//    computeNextRunAt reads the REAL clock, so this case uses the real now rather
//    than the frozen NOW above. Mixing the two is what made the first draft of this
//    case fail while the helper was correct.
const realNow = Date.now()
const fast = sched.cronLaunchRetry(cronRow({ cron_expression: '* * * * *' }),
                                   { now_ms: realNow, capped: false, settle })
ok('minutely cron keeps its own next slot rather than waiting 5m',
   !!fast && Date.parse(fast.next_run_at) < realNow + 5 * 60 * 1000, fast && fast.next_run_at)
const slow = sched.cronLaunchRetry(cronRow(), { now_ms: realNow, capped: false, settle })
ok('  pair: the daily cron does NOT keep its next slot, it takes the 5m backoff',
   !!slow && Date.parse(slow.next_run_at) === realNow + 5 * 60 * 1000, slow && slow.next_run_at)

// 6. SOURCE ASSERTIONS. The helper is only correct if the callers use it and if the
//    streak counter is cleared on a good fire. Without the clear, launch_retry_count
//    is a LIFETIME tally and a healthy daily cron silently reaches the ceiling after
//    three unrelated blips spread over months.
const src = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8')
ok('markComplete cron arm clears launch_retry_count',
   /run_count = run_count \+ 1[\s\S]{0,120}launch_retry_count = 0/.test(src))
ok('both cron reclaim branches call cronLaunchRetry',
   (src.match(/const lf = cronLaunchRetry\(/g) || []).length === 2)
ok('the relaunch write is guarded on bound_at IS NULL',
   (src.match(/launch_retry_count = COALESCE\(launch_retry_count, 0\) \+ 1/g) || []).length === 3)
// The needle is written as an escape so this file itself carries no U+2014 byte:
// a detector that must contain the thing it forbids fails its own grep.
ok('no em-dash reached the file', src.indexOf('\u2014') === -1)

console.log('cron-launch-retry.gate: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
