// Unit test for the cron re-entry guard + run-count anomaly helpers added by
// fix/scheduler-next-run-at-recompute-reentry-guard-2026-06-19.
// Pure helpers only - no DB. Run: node tools/scheduler-next-run-at-recompute.test.js
//
// Covers [[cron-rearm-must-recompute-next-run-at-or-guard-reentry-per-period-2026-06-19]]:
//   cronAlreadyRanThisPeriod  - the re-entry guard truth function
//   computeNextRunAt          - boundary recompute (+ fail-open fallback)
//   runCountAnomalyForRow     - the dispatcher self-audit canary, validated
//                               against the ten real smoking-gun rows
const assert = require('node:assert')
const s = require('./scheduler')

let pass = 0
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name)
  pass++
  process.stdout.write('  ok  ' + name + '\n')
}

const NOW = new Date('2026-06-19T04:00:00.000Z') // 14:00 AEST

// ── cronAlreadyRanThisPeriod ────────────────────────────────────────────────
// Monthly cron, 1st of month 14:00 AEST = 04:00 UTC. prevBoundary @ NOW = 2026-06-01.
const monthly = { type: 'cron', cron_expression: '0 14 1 * *', tz: 'Australia/Brisbane' }

ok('clobber case: monthly ran 06-18 (this period) -> already ran TRUE',
  s.cronAlreadyRanThisPeriod({ ...monthly, last_run_at: '2026-06-18T19:00:00Z' }, NOW) === true)

ok('genuinely due: monthly last ran 05-15 (prior period) -> FALSE',
  s.cronAlreadyRanThisPeriod({ ...monthly, last_run_at: '2026-05-15T04:00:00Z' }, NOW) === false)

ok('never ran (last_run_at null) -> FALSE',
  s.cronAlreadyRanThisPeriod({ ...monthly, last_run_at: null }, NOW) === false)

ok('non-cron row -> FALSE (fail-open)',
  s.cronAlreadyRanThisPeriod({ type: 'delayed', last_run_at: '2026-06-18T00:00:00Z' }, NOW) === false)

ok('garbage cron -> FALSE (fail-open, never un-dispatchable)',
  s.cronAlreadyRanThisPeriod({ type: 'cron', cron_expression: 'not-a-cron', last_run_at: '2026-06-18T00:00:00Z' }, NOW) === false)

// Annual cron Oct 1: the smoking-gun shape. prevBoundary @ 2026-06-19 = 2025-10-01.
// A row that ran 2026-06-04 has clearly already run within the current annual period.
ok('annual cron ran 06-04 within current year period -> already ran TRUE',
  s.cronAlreadyRanThisPeriod({ type: 'cron', cron_expression: '0 9 1 10 *', tz: 'Australia/Brisbane', last_run_at: '2026-06-04T00:00:00Z' }, NOW) === true)

// ── computeNextRunAt ────────────────────────────────────────────────────────
const next = s.computeNextRunAt(monthly, NOW)
ok('computeNextRunAt monthly -> future', new Date(next).getTime() > NOW.getTime())
ok('computeNextRunAt monthly -> next 1st of month (2026-07-01)', next.startsWith('2026-07-01'))

const fb = s.computeNextRunAt({ cron_expression: 'garbage' }, NOW)
ok('computeNextRunAt fail-open -> NOW+1h fallback',
  Math.abs(new Date(fb).getTime() - (NOW.getTime() + 3600000)) < 1000)

// ── runCountAnomalyForRow ───────────────────────────────────────────────────
// All ten real rows were created ~2026-06-04 and observed 2026-06-19 (~15d old).
const CREATED = '2026-06-04T00:00:00Z'
const smoking = [
  ['annual-asic-and-wyoming-renewals', '0 9 1 10 *', 3],
  ['monthly-architectural-review', '0 14 28 * *', 3],
  ['monthly-financial-close', '0 14 1 * *', 5],
  ['bas-quarterly-prep', '0 14 1 1,4,7,10 *', 3],
  ['eofy-tax-prep', '0 14 1 7 *', 5],
  ['monthly-invoice-render', '0 14 1 * *', 4],
  ['monthly-platform-cost-audit', '0 14 2 * *', 5],
  ['quarterly-business-review', '0 14 1 1,4,7,10 *', 4],
  ['client-deliverable-outcome-followup', '0 14 8 * *', 4],
  ['bookkeeping-annual-obligations', '0 14 1 7 *', 7],
]
for (const [name, cron, rc] of smoking) {
  const a = s.runCountAnomalyForRow({ type: 'cron', cron_expression: cron, tz: 'Australia/Brisbane', run_count: rc, created_at: CREATED, name }, NOW)
  ok('anomaly FLAGGED: ' + name + ' (run_count=' + rc + ', expectedMax=' + (a && a.expectedMax) + ')', !!a && a.anomalous === true)
}

// Negative controls: healthy crons must NOT flag.
ok('healthy daily cron 30d old run_count 30 -> NOT flagged',
  s.runCountAnomalyForRow({ type: 'cron', cron_expression: '0 9 * * *', tz: 'Australia/Brisbane', run_count: 30, created_at: '2026-05-20T00:00:00Z', name: 'daily' }, NOW).anomalous === false)

ok('healthy hourly cron 2d old run_count 48 -> NOT flagged',
  s.runCountAnomalyForRow({ type: 'cron', cron_expression: '7 * * * *', tz: 'Australia/Brisbane', run_count: 48, created_at: '2026-06-17T04:00:00Z', name: 'hourly' }, NOW).anomalous === false)

ok('fresh monthly cron run_count 1 (fired once on creation) -> NOT flagged',
  s.runCountAnomalyForRow({ type: 'cron', cron_expression: '0 14 1 * *', tz: 'Australia/Brisbane', run_count: 1, created_at: CREATED, name: 'fresh-monthly' }, NOW).anomalous === false)

ok('non-cron row -> null (no anomaly concept)',
  s.runCountAnomalyForRow({ type: 'delayed', run_count: 99, created_at: CREATED }, NOW) === null)

process.stdout.write('\n' + pass + ' assertions passed\n')
