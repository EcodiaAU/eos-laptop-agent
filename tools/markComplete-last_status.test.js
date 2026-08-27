// rot-w10 2026-06-21: proves markComplete persists last_status on the cron success
// re-arm (the bug: a healthy recurring cron wrote last_status=NULL, so cold-start
// health canaries could not distinguish "ran 26x today" from "never ran"). Mirrors
// the eos-laptop-agent test style (pure injection, no live DB).
//
// Run from inside the repo (so 'pg' resolves):
//   node tools/markComplete-last_status.test.js          -> expect all PASS (post-fix)
// Negative control (proves the bug): point at an UNPATCHED scheduler.js and the
//   'cron re-arm SET includes last_status' assertion FAILS:
//   node tools/markComplete-last_status.test.js <path-to-unpatched-scheduler.js>
//
// Companion doctrine: [[scheduler-completion-must-not-share-seen-flag-with-conductor-inbox-2026-06-18]],
// [[cron-rearm-must-recompute-next-run-at-or-guard-reentry-per-period-2026-06-19]].
'use strict'
const assert = require('node:assert')
const path = require('node:path')

const target = process.argv[2] || path.join(__dirname, 'scheduler.js')
const s = require(path.resolve(target))

let pass = 0
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name)
  pass++
  process.stdout.write('  ok  ' + name + '\n')
}

// Fake pool: capture every query. Returns empty rowset (chain wake-up tolerated).
function makePool() {
  const calls = []
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: 0 }
    },
  }
}
// Dispatcher with no tab to kill; worktree prune stubbed to a no-op (no git subprocess).
s._setDispatcher({ kill_worker: async () => ({ closed: false }) })
s._setWorktreeFns({ prune: async () => {} })

// Helper: find the cron re-arm UPDATE (SET status = 'active' ... next_run_at).
function findCronRearm(calls) {
  return calls.find(c => /UPDATE os_scheduled_tasks/.test(c.sql) && /status = 'active'/.test(c.sql) && /next_run_at = \$1/.test(c.sql))
}
function findOneShotComplete(calls) {
  return calls.find(c => /UPDATE os_scheduled_tasks/.test(c.sql) && /status = 'completed'/.test(c.sql))
}

;(async () => {
  // CASE 1: cron success re-arm, no explicit worker status -> last_status='success'
  {
    const pool = makePool(); s._setPool(pool)
    const row = { id: 'cron-1', type: 'cron', cron_expression: '7 * * * *', tz: 'Australia/Brisbane', run_count: 25 }
    await s.markComplete(row, { result_summary: 'hourly probe ok' }) // no .status -> defaults success
    const q = findCronRearm(pool.calls)
    ok('cron re-arm UPDATE was issued', !!q)
    ok('cron re-arm SET includes last_status (bug fix)', /last_status\s*=\s*\$\d/.test(q.sql))
    ok('cron re-arm still recomputes next_run_at (no regression)', /next_run_at\s*=\s*\$1/.test(q.sql))
    ok("cron re-arm still re-arms status='active' (no regression)", /status\s*=\s*'active'/.test(q.sql))
    ok("default last_status param is 'success'", q.params.includes('success'))
    // The WHERE guard that protects control-state rows must remain.
    ok('cron re-arm WHERE still guards paused/cancelled', /last_status NOT IN \('paused', 'cancelled'\)/.test(q.sql))
  }

  // CASE 2: worker self-reports a finer terminal status -> that value persists
  {
    const pool = makePool(); s._setPool(pool)
    const row = { id: 'cron-2', type: 'cron', cron_expression: '0 14 1 * *', tz: 'Australia/Brisbane', run_count: 14 }
    await s.markComplete(row, { status: 'success', result_summary: 'monthly billing invoiced' })
    const q = findCronRearm(pool.calls)
    ok("worker-reported status 'success' persisted to last_status", q.params.includes('success'))
  }

  // CASE 3: one-shot/delayed terminal path unchanged (status='completed')
  {
    const pool = makePool(); s._setPool(pool)
    const row = { id: 'os-1', type: 'delayed' }
    await s.markComplete(row, { result_summary: 'one-shot done' })
    const q = findOneShotComplete(pool.calls)
    ok('one-shot still terminal-completes (status=completed, unchanged)', !!q)
    ok('one-shot path NOT re-armed as active', !findCronRearm(pool.calls))
  }

  // CASE 4: explicit failure still routes to markFailed (does NOT hit re-arm here)
  {
    const pool = makePool(); s._setPool(pool)
    const row = { id: 'cron-3', type: 'cron', cron_expression: '7 * * * *', tz: 'Australia/Brisbane', run_count: 3, retry_count: 0 }
    await s.markComplete(row, { status: 'failed', result_summary: 'boom' })
    // markFailed (retry<MAX) re-arms status='active' with last_error, NOT the success SET (no last_status='success').
    const successRearm = pool.calls.find(c => /last_status\s*=\s*\$\d/.test(c.sql) && /next_run_at = \$1/.test(c.sql))
    ok('explicit failure does NOT take the success last_status path', !successRearm)
  }

  process.stdout.write('\n' + pass + ' assertions passed\n')
})().catch(e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1) })
