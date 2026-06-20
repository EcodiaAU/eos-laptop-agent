// Behavioural harness for the 2026-06-20 sleep-resilience fix: wake-from-sleep
// detection + immediate catch-up staleLeaseRecovery + observer_signals surfacing.
// Run: node tools/scheduler.wake-stall.test.js   (exit 0 = PASS)
//
// Proves the fix for the fleet-wide stuck-running recurrence (status_board
// 8ec234ed): the Mac laptop hibernates overnight (verified via pmset), freezing
// the Node event loop so the stale-lease setInterval stops ticking; crons leased
// before the freeze sat stuck 16-26h. This harness exercises the REAL staleTick /
// detectWakeStall / recordWakeStall code via the module injection seams.
//
// Pre-fix (no detectWakeStall / staleTick / recordWakeStall exports) this file
// throws on the first call and exits non-zero -> the fault yields. Post-fix it
// asserts the actual behaviour: a sleep-sized inter-tick gap records exactly one
// wake-stall observer signal AND still runs recovery; normal ticks do neither.

const scheduler = require('./scheduler')

let recoveryRuns = 0          // count of staleLeaseRecovery invocations (branch-1 UPDATE)
const observerInserts = []    // captured observer_signals INSERTs

scheduler._setPool({
  async query(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('INSERT INTO observer_signals')) {
      observerInserts.push({ params })
      return { rows: [], rowCount: 1 }
    }
    // staleLeaseRecovery branch-1 is the once-per-call fingerprint. Since 4cab6c3
    // (liveness gate) branch-1 is a SELECT of stale retryable dispatching rows +
    // a per-row UPDATE, not the old bulk UPDATE. The branch-1 SELECT fires exactly
    // once per staleLeaseRecovery call regardless of matched rows; retry_count <
    // distinguishes it from branch-2a (retry_count >=).
    if (s.startsWith('SELECT id, name FROM os_scheduled_tasks') && s.includes("status = 'dispatching'") && s.includes('retry_count <')) {
      recoveryRuns++
      return { rows: [], rowCount: 0 }
    }
    // every other staleLeaseRecovery query (SELECT branches, per-row UPDATEs) -> empty
    return { rows: [], rowCount: 0 }
  },
})
scheduler._setCoord({ async list_workers() { return { workers: [] } } })
scheduler._setDispatcher({ async kill_worker() { return { closed: true } } })
scheduler._setWorktreeFns({ pruneWorktreeForRow: async () => {} })

const results = {}
function eq(name, got, want) { results[name] = (got === want); if (got !== want) results[name + '__got'] = got }

;(async () => {
  // ── Part A: detectWakeStall is pure + correctly classifies ──
  const MIN = 60_000
  eq('A_sleepGap_stalled',    scheduler.detectWakeStall(0, 4 * MIN, MIN, 3).stalled, true)
  eq('A_sleepGap_frozenMs',   scheduler.detectWakeStall(0, 4 * MIN, MIN, 3).frozenMs, 4 * MIN)
  eq('A_normalTick_notStalled', scheduler.detectWakeStall(0, MIN, MIN, 3).stalled, false)
  eq('A_justUnder3x_notStalled', scheduler.detectWakeStall(0, 170_000, MIN, 3).stalled, false)
  eq('A_justOver3x_stalled',  scheduler.detectWakeStall(0, 181_000, MIN, 3).stalled, true)
  eq('A_defaultFactor_is_3',  scheduler.detectWakeStall(0, 181_000, MIN).stalled, true)

  // ── Part B: staleTick wake path drives recovery + surfacing with an injected clock ──
  scheduler._resetStaleTickClock(null)
  scheduler._resetWakeStallLast()
  scheduler._wakeStallCount = 0
  recoveryRuns = 0
  observerInserts.length = 0

  const t0 = 1_000_000_000_000   // arbitrary fixed epoch ms (deterministic)
  await scheduler.staleTick(t0)                       // seed: no prev tick
  eq('B_seed_noObserver', observerInserts.length, 0)
  eq('B_seed_recoveryRan', recoveryRuns, 1)

  await scheduler.staleTick(t0 + 60_000)              // normal 60s tick
  eq('B_normal_noObserver', observerInserts.length, 0)
  eq('B_normal_recoveryRan', recoveryRuns, 2)
  eq('B_normal_noWakeCount', scheduler._wakeStallCount, 0)

  await scheduler.staleTick(t0 + 60_000 + 9 * 3600_000) // 9h freeze -> wake
  eq('B_wake_observerWritten', observerInserts.length, 1)
  eq('B_wake_recoveryStillRan', recoveryRuns, 3)
  eq('B_wake_countIncremented', scheduler._wakeStallCount, 1)

  // The surfaced signal must be the wake-stall kind with a sane minute count.
  const ins = observerInserts[0] && observerInserts[0].params
  eq('B_wake_signalKind', ins && ins[1], 'scheduler_wake_stall')
  const msg = (ins && ins[2]) || ''
  eq('B_wake_msgMentionsFreeze', /frozen ~5\d\d min/.test(msg), true)  // ~9h = 540 min

  const failed = Object.keys(results).filter(k => !k.endsWith('__got') && results[k] !== true)
  console.log(JSON.stringify(results, null, 2))
  if (failed.length) { console.log('FAIL: ' + failed.join(', ')); process.exit(1) }
  console.log('PASS: wake-stall detection records one signal per sleep gap, recovery runs on every tick')
  process.exit(0)
})().catch(e => { console.error('HARNESS ERROR (expected pre-fix: new exports absent)', e.message); process.exit(2) })
