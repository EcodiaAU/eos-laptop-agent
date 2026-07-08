// scheduler.js - autonomy substrate scheduler module (Phase 3).
//
// Polls os_scheduled_tasks in Supabase Postgres every 30s, rotates
// ~/.claude/.credentials.json to the healthiest account, dispatches a CC chat
// tab via cowork.dispatch_worker, and tracks completion via coord inbox.
//
// Feature flag: SCHEDULER_ENABLED=true must be set explicitly. The scheduler
// does NOT start automatically to prevent unintended Postgres polling on agent
// restart before the substrate is ready.
//
// Architecture:
//   - dispatch loop (every 30s): leaseDueRows -> dispatchOne (serial, launch-lock)
//   - completion pass (every 5s): check coord inbox for done signals
//   - stale-lease recovery (every 60s): release leaked leases + mark orphans
//
// Invariants:
//   - launch-lock is always released in finally blocks.
//   - Status transitions: active -> dispatching -> running -> (completed|failed|orphaned)
//   - AllAccountsCappedError defers, does not fail.

'use strict'

const { Pool } = require('pg')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileP = promisify(execFile)
// Single source of truth for schedule semantics (vendored byte-identical from
// ecodiaos-backend/src/lib/schedule-core.js, pinned by schedule-core-identity.test.js).
// Handles intervals of ANY size, daily, weekly, and raw cron. Replaced the
// in-file parseSchedule + scattered cron-parser dances that mis-fired intervals
// over 23h (every Nh was faked into "0 */N * * *" -> cron-parser collapsed it to
// daily). Doctrine: scheduler-one-schedule-engine-2026-06-20.
const scheduleCore = require('../lib/schedule-core')
let _credsModule = require('./creds')
function getCreds() { return _credsModule }
exports._setCredsModule = function (m) { _credsModule = m }
const coord = require('./coord')
// Injection seam: tests pass a stub coord implementing { list_workers }.
// Only the stale-lease liveness check routes through getCoord(); the other
// coord call sites (completionPass) read coord directly to avoid behaviour
// drift in well-tested paths.
let _coordOverride = null
function getCoord() { return _coordOverride || coord }
exports._setCoord = function (c) { _coordOverride = c }

// ── constants ────────────────────────────────────────────────────────────────

// 2026-06-10 branch-thrash guard: each dispatched worker gets its own git
// worktree off origin/main so its branch flips and commits cannot reach the
// conductor's shared tree. Paired with the reference-transaction hook in
// backend/scripts/branch-thrash-guard.sh which is the runtime backstop.
//
// SHARED_TREE: the conductor's working tree. We invoke `git worktree add` from
// here so the worktree is registered against the shared .git directory.
// WORKTREE_ROOT: parent path for per-task linked worktrees. Predictable per
// row.id so allocate+prune is idempotent across retries and crashes.
//
// Doctrine: backend/patterns/branch-thrash-guard-on-shared-tree-2026-06-10.md
const SHARED_TREE = process.env.SCHEDULER_SHARED_TREE || '/Users/ecodia/.code/ecodiaos/backend'
const WORKTREE_ROOT = process.env.SCHEDULER_WORKTREE_ROOT || '/Users/ecodia/.code/ecodiaos/_worktrees/dispatched'
const WORKTREE_GIT_TIMEOUT_MS = 30_000

const POLL_INTERVAL_MS = 30_000
const STALE_LEASE_INTERVAL_MS = 60_000
const DISPATCH_LIMIT = 5
// 2026-05-29 ultracode audit H5 fix. Was 30000, below the 84.5s cold-MCP
// observed floor + spike margin per worker-ack-timeout doctrine. On timeout
// the launch-lock released, defeating the cred-rotation serialisation.
// 2026-06-08 self-evolution bump: empirical Mac cold-MCP signal_bound
// latency (n=60 across last 4h on this agent) p50=24s p75=32s p90=77s
// p95=402s max=1283s. The 180s cap was missing the entire p90-p99 tail and
// most dispatches were logging signal_bound timeout despite the worker
// having successfully paste'd + read its brief; the rows still ran but
// recovery + cleanup-orphan churn was real. 600s catches p95 cleanly while
// keeping launch-lock throughput acceptable (next dispatch can still proceed
// every 10min worst-case). Tunable via env without code change.
const SIGNAL_BOUND_TIMEOUT_MS = parseInt(process.env.SCHEDULER_SIGNAL_BOUND_TIMEOUT_MS, 10) || 600_000
const ORPHAN_TIMEOUT_MS = 6 * 60 * 60 * 1000
// 2026-06-22 cadence-aware running-orphan reclaim. ORPHAN_TIMEOUT_MS (6h) is the
// correct backstop for a one-shot delayed worker (orphaning it is terminal and
// destructive, and a one-shot can legitimately run long), but it is far too slow
// for a fast CRON whose worker binds (flips to status='running') then dies
// silently without coord.signal_done: the row sits stuck 'running' and BLOCKS
// every subsequent fire until 6h elapse. For an hourly cron that is ~6 lost
// cycles. Observed twice in the same shape on gmail-inbox-poll (heal 2026-06-21
// 11:43Z, recurred 2026-06-22 ~07:16Z lease, inbox triage cadence blind ~6h).
// The branch-3 liveness gate (hasLiveWorkerForTask) already refuses to reclaim a
// worker that is still heartbeating, so a SHORTER window for cron rows cannot
// thunder-herd a live worker; it only lets a provably-dead cron worker (heartbeat
// stale > STALE_WORKER_LIVENESS_MS, or absent from coord) recover within minutes
// instead of hours, and cron reclaim is non-destructive (defer to next interval,
// never terminal orphan). 30min sits decisively above the ~21min p99 cold-bind
// tail (a running row has already bound, so that tail does not even apply) yet is
// 12x faster than 6h. Non-cron rows keep the full 6h ORPHAN_TIMEOUT_MS. Tunable.
// Doctrine: scheduler-running-orphan-reclaim-must-be-cadence-aware-2026-06-22.
const RUNNING_CRON_ORPHAN_MS = parseInt(process.env.SCHEDULER_RUNNING_CRON_ORPHAN_MS, 10) || 30 * 60 * 1000
const COMPLETION_POLL_INTERVAL_MS = 5_000
// 2026-06-18 half-state race fix. Must stay ABOVE SIGNAL_BOUND_TIMEOUT_MS (600s)
// so staleLeaseRecovery branch-1 cannot reap a row that dispatchOne is still
// legitimately waiting on for signal_bound. When the two windows were equal
// (both 10min) a slow-but-live cold-MCP bind got reclaimed mid-wait, and the
// running-flip then produced a status=running + leased_by=NULL zombie. 15min
// gives 5min of headroom over the bind timeout; the p99 bind tail (~21min) is
// covered by the dispatchOne running-flip lease guard, not by this window.
const STALE_DISPATCHING_MS = 15 * 60 * 1000   // 15 min -> retry (> 600s bind timeout)
const MAX_RETRY_COUNT = 3
// 2026-06-19 next_run_at-recompute fix. staleLeaseRecovery branch 1 (retryable
// stale-dispatch) used to free the row back to 'active' while leaving next_run_at
// at its past-due value, so the row was due on the very next 30s poll and re-fired
// off-cadence up to MAX_RETRY times. Per
// [[cron-rearm-must-recompute-next-run-at-or-guard-reentry-per-period-2026-06-19]]
// a retry must use a BOUNDED short delay, never an unbounded immediate re-due.
// 5 min preserves up to MAX_RETRY quick re-attempts for a transient bind failure
// (3 retries spread over ~15 min) without hammering every poll, and is short
// enough that a genuinely-due cron loses no cadence. The leaseDueRows re-entry
// guard is the second layer: a cron that already RAN this period is dropped from
// dispatch regardless of how next_run_at got clobbered.
const RETRY_BACKOFF_MS = 5 * 60 * 1000   // 5 min bounded retry delay
// 2026-05-29 ultracode audit C3 fix. cleanup_orphan_workers is the only
// backstop the chain's refuse-and-leak posture relies on; the audit caught
// it wired to no cron at all. 7 min picks up leaked tabs within a worker
// lifetime, doesn't thrash ide.tabs.
const CLEANUP_ORPHAN_INTERVAL_MS = 7 * 60 * 1000

// 2026-06-20 sleep-resilience. The agent runs on a Mac laptop with no caffeinate
// wrapper; KeepAlive in the launchd plist only restarts the process on EXIT, not
// when the OS freezes it during system sleep / hibernate. When the host sleeps,
// the Node event loop stops and ALL setInterval loops below (dispatch, completion,
// stale-lease recovery, cap observer, orphan cleanup) stop ticking. Crons leased
// into status='dispatching'/'running' just before the freeze then sit stuck until
// the agent next gets sustained runtime. Verified root cause of the 2026-06-18 and
// 2026-06-19 fleet-wide stuck-running recurrences: pmset shows the host hibernated
// on a 1% battery for ~9h ('Low Power Sleep' TCPKeepAlive=inactive), waking only on
// acattach, and the named crons recovered only once the host was sustainedly awake.
// We cannot stop the host sleeping from inside the process (critical-battery
// hibernate ignores caffeinate), but we CAN make the first resumed tick reconcile
// immediately and emit an OBSERVABLE wake-stall signal instead of a silent stall.
// A gap between consecutive stale-lease ticks far exceeding STALE_LEASE_INTERVAL_MS
// is the fingerprint of a frozen-then-resumed loop. Doctrine:
// [[scheduler-must-survive-mac-sleep-2026-06-20]].
const WAKE_STALL_FACTOR = 3

// ── Postgres pool (injection seam for tests) ─────────────────────────────────

let _pool = null

function getPool() {
  if (!_pool) {
    const connStr = process.env.DATABASE_URL
    if (!connStr) throw new Error('scheduler: DATABASE_URL env var is required')
    _pool = new Pool({
      connectionString: connStr,
      keepAlive: true,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    // 2026-06-14 restart-loop root-cause fix. node-postgres emits an 'error'
    // event on the Pool when an IDLE pooled client's TCP connection dies. The
    // Supabase transaction/session pooler drops idle connections routinely,
    // surfacing as "Connection terminated unexpectedly". With NO listener on
    // this event, Node treats it as an uncaughtException and KILLS THE PROCESS;
    // launchd respawns the agent, the next idle connection drops again, and the
    // whole laptop-agent restart-loops (42 boots observed in one log). A
    // no-op-but-present listener makes the drop non-fatal - node-postgres
    // transparently opens a fresh connection on the next query.
    _pool.on('error', (err) => {
      process.stderr.write('[scheduler] pg pool idle-client error (non-fatal, pool reconnects): ' + (err && err.message || err) + '\n')
    })
  }
  return _pool
}

// Injection seam: tests pass a stub pool object implementing { query(sql, params) }
exports._setPool = function (p) { _pool = p }

// ── dispatcher (injection seam for tests) ────────────────────────────────────

let _dispatcher = null

function getDispatcher() {
  if (!_dispatcher) {
    _dispatcher = require('./cowork')
  }
  return _dispatcher
}

// Injection seam: tests pass a stub dispatcher implementing { dispatch_worker }
exports._setDispatcher = function (d) { _dispatcher = d }

// ── worktree allocator (injection seam for tests) ────────────────────────────
//
// 2026-06-10 branch-thrash guard. Per-row isolated worktree off origin/main so
// the dispatched worker tab can `git checkout -b`, commit, even `git reset
// --hard` without touching the conductor's shared tree. The shared tree's
// .git/hooks/reference-transaction is the backstop when a worker still tries
// the shared path despite the brief.
//
// Path scheme: WORKTREE_ROOT/<row.id> - predictable across retries so
// allocate+prune is idempotent. allocateWorktreeForRow first force-prunes any
// stale entry at that path, then `git worktree add -B worker/<row.id>` off
// origin/main. The branch name uses the FULL row.id (not a truncated prefix)
// so two concurrent dispatches with similar id prefixes do not collide on the
// branch ref - a 2026-06-10 verify-gate failure caught this exact case.
// pruneWorktreeForRow is callable on completion, failure, orphan, and
// stale-lease paths without state-tracking.

const fs = require('fs')
const path = require('path')

async function defaultAllocateWorktreeForRow(row) {
  const wtPath = path.join(WORKTREE_ROOT, String(row.id))
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })

  // Idempotent cleanup: forget any stale worktree at that path first.
  await runGit(['worktree', 'remove', '--force', wtPath]).catch(() => {})
  await runGit(['worktree', 'prune']).catch(() => {})

  // 2026-06-20: `worktree remove --force` is a silent no-op when the path
  // exists on disk but is no longer a REGISTERED worktree (crashed prior
  // dispatch, or git metadata pruned out from under it). The swallowed error
  // left the directory standing, so the `worktree add` below died with
  // "<path> already exists" and the row fell back to an UNISOLATED shared-tree
  // dispatch - a branch-thrash hazard that is acute when several conductor
  // chats run concurrently. Force-clear any surviving directory so add always
  // lands on a clean path. Same destroy-on-redispatch posture as the
  // remove --force above (the path is keyed to THIS row.id, whose prior attempt
  // is dead); scoped strictly under WORKTREE_ROOT as a safety bound.
  if (fs.existsSync(wtPath) && wtPath.startsWith(WORKTREE_ROOT + path.sep)) {
    fs.rmSync(wtPath, { recursive: true, force: true })
    await runGit(['worktree', 'prune']).catch(() => {})
  }

  // Refresh origin/main so the worktree branches off recent base.
  await runGit(['fetch', 'origin', 'main', '--quiet']).catch(() => {})

  const branchName = 'worker/' + String(row.id)
  await runGit(['worktree', 'add', '-B', branchName, wtPath, 'origin/main'])
  return wtPath
}

async function defaultPruneWorktreeForRow(row) {
  const wtPath = path.join(WORKTREE_ROOT, String(row.id))
  await runGit(['worktree', 'remove', '--force', wtPath]).catch(() => {})
  await runGit(['worktree', 'prune']).catch(() => {})
}

async function runGit(args) {
  // ECODIAOS_BRANCH_OK=1 lets the dispatcher's own worktree add survive even
  // when the shared-tree hook tightens. The hook today only blocks HEAD updates
  // on the shared tree; worktree add does not move HEAD there. The env var is
  // a future-proof for hook tightening.
  const env = Object.assign({}, process.env, { ECODIAOS_BRANCH_OK: '1' })
  return execFileP('git', ['-C', SHARED_TREE].concat(args), {
    timeout: WORKTREE_GIT_TIMEOUT_MS,
    env,
  })
}

let _allocateWorktreeForRow = defaultAllocateWorktreeForRow
let _pruneWorktreeForRow = defaultPruneWorktreeForRow

exports.allocateWorktreeForRow = function (row) { return _allocateWorktreeForRow(row) }
exports.pruneWorktreeForRow = function (row) { return _pruneWorktreeForRow(row) }

// Injection seam: tests pass {allocate, prune} stubs to skip subprocess git.
exports._setWorktreeFns = function (fns) {
  if (fns && typeof fns.allocate === 'function') _allocateWorktreeForRow = fns.allocate
  if (fns && typeof fns.prune === 'function') _pruneWorktreeForRow = fns.prune
}
exports._resetWorktreeFns = function () {
  _allocateWorktreeForRow = defaultAllocateWorktreeForRow
  _pruneWorktreeForRow = defaultPruneWorktreeForRow
}

// ── launch-lock (in-memory async mutex) ──────────────────────────────────────
//
// Makes dispatching serial even when the dispatch loop fires multiple rows.
// MUST be acquired BEFORE cred rotation and released AFTER coord signal_bound
// is received (or timeout). Released in finally blocks to prevent deadlock.

const _launchLockQueue = []
let _launchLockHeld = false

async function launchLockAcquire() {
  if (!_launchLockHeld) {
    _launchLockHeld = true
    return _launchLockRelease
  }
  return new Promise(resolve => {
    _launchLockQueue.push(resolve)
  })
}

function _launchLockRelease() {
  if (_launchLockQueue.length > 0) {
    const next = _launchLockQueue.shift()
    next(_launchLockRelease)
  } else {
    _launchLockHeld = false
  }
}

exports._launchLock = { acquire: launchLockAcquire }

// ── buildBrief ───────────────────────────────────────────────────────────────
//
// Composes the brief pasted into the spawned CC chat tab. Workers MUST call
// coord.signal_bound as their first action (releases the scheduler launch-lock)
// and coord.signal_done when the task is complete.

exports.buildBrief = function buildBrief(row) {
  const taskId = row.id || row.task_id || 'unknown'
  const accountLine = row.actual_account
    ? 'Account rotated to: ' + row.actual_account + '.'
    : 'Account: current (no rotation performed).'
  const orphanHours = Math.round(ORPHAN_TIMEOUT_MS / (60 * 60 * 1000))

  const lines = []

  // 2026-06-10 branch-thrash guard. When the dispatcher allocated an isolated
  // worktree for this row, the brief carries the path so the worker operates
  // there and never touches the conductor's shared tree. The hook in the
  // shared tree's .git/hooks/reference-transaction is the backstop if the
  // worker still tries.
  if (row.worktree_path) {
    lines.push(
      'WORKTREE: ' + row.worktree_path,
      '',
      'Your isolated working tree is at the path above. Use ABSOLUTE paths under',
      'it for every file operation. Run all git commands with',
      '  git -C ' + row.worktree_path + ' ...',
      'or by first changing into that directory.',
      '',
      'Do NOT operate on /Users/ecodia/.code/ecodiaos/backend - that is the',
      "conductor's shared working tree and its reference-transaction hook will",
      'reject branch flips there (see backend/patterns/branch-thrash-guard-on-',
      'shared-tree-2026-06-10.md). The dispatcher prunes this worktree on your',
      'signal_done.',
      '',
    )
  }

  lines.push(
    // FIRST instruction: signal_bound with task_id so scheduler release launch-lock.
    'FIRST ACTION (mandatory, before any task work):',
    'Call coord.signal_bound now with { task_id: "' + taskId + '" } to confirm you received this brief.',
    'This releases the scheduler launch-lock and transitions the task row to status=running.',
    '',
    // Task prompt verbatim.
    'TASK:',
    row.prompt || '(no prompt set on this task row)',
    '',
    // signal_done instructions.
    'COMPLETION (mandatory):',
    'When the task is complete (success or failure), call coord.signal_done with:',
    '  { task_id: "' + taskId + '", result_summary: "<brief summary>", status: "success"|"failed", terminate: true }',
    'This updates the task row and (for cron tasks) schedules the next run.',
    '',
    // Context line.
    accountLine,
    'If this task has not called signal_done within ' + orphanHours + 'h it will be marked orphaned.',
  )

  return lines.join('\n')
}

// ── cron re-entry guard helpers ──────────────────────────────────────────────
//
// Root-cause defenses for
// [[cron-rearm-must-recompute-next-run-at-or-guard-reentry-per-period-2026-06-19]].
// All three are PURE and FAIL-OPEN: any parse error or missing field returns the
// "dispatch normally" answer, so the guard can never make a row un-dispatchable.
// Worst case a helper is a no-op; it can never stall the fleet.

// True iff a cron row has already run for its current scheduled period. A row is
// "due" in leaseDueRows when next_run_at <= NOW(); if any path clobbers next_run_at
// into the past while last_run_at still points at the run that already happened this
// period, the row would re-dispatch every poll. This compares last_run_at against
// the most recent scheduled boundary at/before `now`: a legitimately-due row (boundary
// just passed, not yet run) has last_run_at from the PRIOR period (strictly before the
// boundary); a clobbered already-ran row has last_run_at at/after it.
exports.cronAlreadyRanThisPeriod = function cronAlreadyRanThisPeriod(row, now) {
  try {
    if (!row || row.type !== 'cron' || !row.cron_expression) return false
    if (!row.last_run_at) return false // never ran -> genuinely due
    const ref = now instanceof Date ? now : new Date()
    const tz = row.tz || 'Australia/Brisbane'
    const prevBoundary = scheduleCore.prevRun(row.cron_expression, ref, tz)
    if (!prevBoundary) return false
    const lastRun = new Date(row.last_run_at)
    if (isNaN(lastRun.getTime())) return false
    return lastRun.getTime() >= prevBoundary.getTime()
  } catch (_e) {
    return false
  }
}

// Next scheduled boundary for a cron row as an ISO string. Fails open to a 1h
// fallback (mirrors the catch in staleLeaseRecovery branches 2a/3).
exports.computeNextRunAt = function computeNextRunAt(row, now) {
  const baseMs = now instanceof Date ? now.getTime() : Date.now()
  const tz = (row && row.tz) || 'Australia/Brisbane'
  const d = scheduleCore.nextRun(row && row.cron_expression, new Date(baseMs), tz)
  return d ? d.toISOString() : new Date(baseMs + 60 * 60 * 1000).toISOString()
}

// Run-count anomaly detector (observability). A cron's run_count is a LIFETIME
// counter; a value far above what the schedule could have produced since the row
// was created is the fingerprint of off-cadence re-firing (an annual cron created
// two weeks ago with run_count > 1 is impossible). Returns null for non-cron rows
// or when the period can't be derived; otherwise {anomalous, runCount, expectedMax,
// periodMs, ageMs, name, id}. Pure + fail-open.
exports.runCountAnomalyForRow = function runCountAnomalyForRow(row, now) {
  try {
    if (!row || row.type !== 'cron' || !row.cron_expression) return null
    if (!row.created_at) return null
    const ref = now instanceof Date ? now : new Date()
    const tz = row.tz || 'Australia/Brisbane'
    // Period = gap between two consecutive occurrences (interval ms, or two cron iterations).
    const periodMs = scheduleCore.periodMs(row.cron_expression, tz)
    if (!(periodMs > 0)) return null
    const ageMs = ref.getTime() - new Date(row.created_at).getTime()
    if (!(ageMs >= 0)) return null
    // Physical maximum lifetime fires: whole periods elapsed since creation, +1
    // for a possible fire on the creation boundary.
    const expectedMax = Math.floor(ageMs / periodMs) + 1
    const runCount = Number(row.run_count || 0)
    // Alarm when run_count exceeds DOUBLE the physical maximum AND the row is
    // still young (few periods elapsed). The young-row gate is deliberate: the
    // bug signature is "a newly-created cron firing impossibly often" (an annual
    // cron created two weeks ago has expectedMax=1, so run_count>=3 trips; the ten
    // 2026-06-19 smoking guns were all <=22-day-old low-frequency crons with
    // expectedMax=1). For a MATURE row the lifetime run_count is dominated by
    // history and by any cron_expression edit made mid-life (live 2026-06-19:
    // research-batch + self-evolution carry 220/153 lifetime fires against a now-
    // weekly expression, a schedule edit, not a bug), so flagging it would be
    // recurring noise. Capping at MAX_AUDIT_PERIODS keeps the canary to the
    // first ~6 periods of a cron's life, where the off-cadence bug actually shows.
    const MAX_AUDIT_PERIODS = 6
    const anomalous = expectedMax <= MAX_AUDIT_PERIODS && runCount > expectedMax * 2
    return { anomalous, runCount, expectedMax, periodMs, ageMs, name: row.name || null, id: row.id }
  } catch (_e) {
    return null
  }
}

// ── leaseDueRows ─────────────────────────────────────────────────────────────
//
// Atomically transitions up to `limit` due active rows to status=dispatching
// using FOR UPDATE SKIP LOCKED so concurrent schedulers (if any) don't
// double-dispatch the same row.
//
// "Due" means: status='active' AND next_run_at <= NOW() (or next_run_at IS NULL)
// Ordered by priority ASC (1=highest), then next_run_at ASC.

exports.leaseDueRows = async function leaseDueRows(limit) {
  const n = (typeof limit === 'number' && limit > 0) ? limit : DISPATCH_LIMIT
  const pool = getPool()
  const leaseId = 'scheduler-' + process.pid + '-' + Date.now()
  // 2026-06-01 Phase A2: exclude paused (last_status='paused') and cancelled
  // (archived_at IS NOT NULL OR last_status='cancelled') rows. User-control
  // surface for the new CRUD tools (schedule_pause/cancel/resume).
  //
  // Chain rows with chain_after set sit parked at next_run_at=NULL until the
  // parent completes (markComplete wakes them). Without the NULL-guard, the
  // existing "next_run_at IS NULL" branch would lease them immediately.
  const sql = `
    WITH due AS (
      SELECT id FROM os_scheduled_tasks
      WHERE status = 'active'
        AND archived_at IS NULL
        AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))
        -- Austerity suppresses RECURRING crons only. One-shot delayed/chain/followup
        -- rows have no austerity band (L4 doctrine: "only one-off delayed tasks +
        -- followups" fire = delayed tasks survive at EVERY level), so the marker must
        -- never strand them. Without the type guard, a stray marker on a delayed row
        -- (a manual bulk UPDATE over-reaching, as happened 2026-06-15) excludes it
        -- forever because the cron-only austerity resume sweep can never clear it.
        AND (austerity_paused IS NOT TRUE OR type <> 'cron')
        AND (next_run_at IS NULL OR next_run_at <= NOW())
        AND (chain_after IS NULL OR next_run_at IS NOT NULL)
      ORDER BY priority ASC, next_run_at ASC NULLS FIRST
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE os_scheduled_tasks t
    SET status = 'dispatching',
        leased_by = $2,
        leased_at = NOW(),
        updated_at = NOW()
    FROM due
    WHERE t.id = due.id
    RETURNING t.*
  `
  const result = await pool.query(sql, [n, leaseId])

  // Post-lease re-entry guard. The due-query above tests next_run_at <= NOW()
  // only; a row whose next_run_at was clobbered into the past while it already
  // ran this period (the staleLeaseRecovery branch-1 history, or any manual /
  // script re-arm) would re-dispatch every poll. Catch it here: recompute
  // next_run_at to the true next boundary, release the lease, and drop it from
  // this batch. This is the clobber-source-independent layer that protects the
  // fleet no matter HOW next_run_at got mangled. Only cron rows, only the few
  // just leased, so the cost is negligible. The release UPDATE carries the same
  // cancellation/pause guard as every other re-arm site, and is scoped to the
  // row WE just leased (status='dispatching' AND leased_by=$leaseId) so a
  // concurrent sweep cannot be clobbered.
  // [[cron-rearm-must-recompute-next-run-at-or-guard-reentry-per-period-2026-06-19]]
  const nowRef = new Date()
  const dispatchable = []
  for (const row of result.rows) {
    if (exports.cronAlreadyRanThisPeriod(row, nowRef)) {
      const nextRunAt = exports.computeNextRunAt(row, nowRef)
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'active', next_run_at = $1,
             last_error = 'reentry-guard: already ran this period, next_run_at recomputed (clobber-safe)',
             leased_by = NULL, leased_at = NULL, updated_at = NOW()
         WHERE id = $2 AND status = 'dispatching' AND leased_by = $3
           AND archived_at IS NULL
           AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
        [nextRunAt, row.id, leaseId]
      )
      process.stderr.write('[scheduler] leaseDueRows: re-entry guard skipped ' + row.id +
        ' (' + (row.name || '?') + ') - already ran this period; next_run_at -> ' + nextRunAt + '\n')
      continue
    }
    dispatchable.push(row)
  }
  return dispatchable
}

// ── markFailed ───────────────────────────────────────────────────────────────
//
// Called when dispatchOne encounters an error that is NOT AllAccountsCappedError.
// Increments retry_count, clears the lease, and leaves status=active so the
// row will be picked up again. After MAX_RETRY_COUNT retries, sets status=failed.

exports.markFailed = async function markFailed(row, err) {
  const pool = getPool()
  const newRetryCount = (row.retry_count || 0) + 1
  const errMsg = String(err && err.message || err).slice(0, 2000)

  // 2026-06-10 branch-thrash guard cleanup: drop the per-row isolated worktree.
  // Even on cron-defer-to-next-interval the worktree should be cleaned: the
  // next fire will allocate a fresh one off origin/main (the FF history may
  // have advanced) and idempotent allocate would tolerate either path.
  try { await exports.pruneWorktreeForRow(row) } catch (_e) {}
  if (newRetryCount >= MAX_RETRY_COUNT) {
    // 2026-06-02 P0 fix. Cron rows MUST NOT permanently die after 3 retries -
    // that loses every future interval of recurring work. Defer to the next
    // cron interval and reset retry_count instead. Non-cron rows still
    // permanently fail (one-shot work is genuinely done after 3 failed tries).
    if (row.type === 'cron' && row.cron_expression) {
      let nextRunAt = null
      try {
        nextRunAt = exports.computeNextRunAt(row)
      } catch (_e) {
        nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'active', retry_count = 0, last_error = $1, next_run_at = $2,
             leased_by = NULL, leased_at = NULL, updated_at = NOW()
         WHERE id = $3
           AND archived_at IS NULL
           AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
        [errMsg + ' (cron: deferred to next interval, retry_count reset)', nextRunAt, row.id]
      )
    } else {
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'failed', retry_count = $1, last_error = $2,
             leased_by = NULL, leased_at = NULL, updated_at = NOW()
         WHERE id = $3`,
        [newRetryCount, errMsg, row.id]
      )
    }
  } else {
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', retry_count = $1, last_error = $2,
           leased_by = NULL, leased_at = NULL, updated_at = NOW()
       WHERE id = $3
         AND archived_at IS NULL
         AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
      [newRetryCount, errMsg, row.id]
    )
  }
}

// ── isTransientBridgeError ───────────────────────────────────────────────────
//
// 2026-06-20 autonomy audit finding (c). The dispatch_worker editor.open path
// can fail not only with "no IDE instances registered" (no IDE bound) but with
// a socket-class error when the IDE bridge blips mid-open: "populate failed
// (editor.open): socket hang up", ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE.
// All are TRANSIENT infra unavailability, not a task fault. Before this fix only
// the literal "no IDE instances registered" string got the gentle 5min defer;
// the socket-class errors fell through to markFailed, which PERMANENTLY fails a
// one-shot / delayed row once retry_count hits MAX (silent loss of scheduled
// work - the self-scheduling backbone). Classify all of them as transient so
// dispatchOne defers instead of failing.
const _TRANSIENT_BRIDGE_RE = /(no IDE instances registered|populate failed|editor\.open|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EPIPE|socket disconnected|bridge (?:unavailable|timeout))/i
exports.isTransientBridgeError = function isTransientBridgeError(msg) {
  return _TRANSIENT_BRIDGE_RE.test(String(msg || ''))
}

// ── dispatchOne ──────────────────────────────────────────────────────────────
//
// Dispatches a single leased row. Acquires launch-lock BEFORE cred rotation,
// releases it AFTER coord signal_bound is received (or timeout).
//
// Invariant: launch-lock is released in the finally block even if an error
// is thrown at any point.

exports.dispatchOne = async function dispatchOne(row) {
  const pool = getPool()
  const release = await launchLockAcquire()
  let account = null
  let tabId = null
  try {
    // 0. Defense-in-depth austerity gate. leaseDueRows already excludes
    // austerity_paused rows, but a 2026-06-19 incident showed ~8 paused crons
    // (calendar-watch, opportunity-triage, neo4j-maintenance, monthly-financial-close,
    // github-push-ci-watch ...) reaching dispatchOne in a 3-min burst and spawning
    // worker tabs despite the gate (unreproducible race between lease + stale-lease
    // recovery under the signal_bound hold). The harm is a spawned CC session burning
    // tokens while austerity is meant to suppress it. Re-read the marker here, under
    // the launch-lock (fresh read), BEFORE any cred rotation / worktree / tab spawn.
    // If the row is now paused (or gone/cancelled), release the lease and skip - NOT
    // markFailed: this is a suppression, not a failure, so it must not burn a retry or
    // defer the cron off its cadence. next_run_at is left intact so the row rejoins
    // its schedule the moment austerity lifts.
    {
      const guard = await pool.query(
        `SELECT austerity_paused, status, archived_at, last_status, name
         FROM os_scheduled_tasks WHERE id = $1`,
        [row.id]
      )
      const g = guard.rows[0]
      // Fire ONLY on the explicit suppression markers. A missing read (g
      // undefined) is left to proceed - the guard targets the austerity marker,
      // not row existence, and a genuinely-deleted row fails downstream anyway.
      const suppressed = !!g && (
        g.austerity_paused === true ||
        g.archived_at != null ||
        g.last_status === 'cancelled'
      )
      if (suppressed) {
        await pool.query(
          `UPDATE os_scheduled_tasks
           SET status = 'active', leased_by = NULL, leased_at = NULL, updated_at = NOW()
           WHERE id = $1
             AND status = 'dispatching'
             AND leased_by IS NOT DISTINCT FROM $2`,
          [row.id, row.leased_by || null]
        )
        process.stderr.write('[scheduler] dispatchOne: SKIP ' + row.id + ' (' +
          (g && g.name || row.name || '?') + ') - austerity_paused gate ' +
          '(defense-in-depth); upstream leaseDueRows leak, lease released without retry\n')
        return
      }
    }

    // 1. Dispatch on the account that is ALREADY live. No per-dispatch rotation.
    // 2026-06-29 switcher consolidation. The Mac shares ONE Keychain, so a
    // dispatched worker and the interactive conductor are ALWAYS the same account
    // at any instant - rotating for a worker moves EVERYONE, including Tate's live
    // session. Per-dispatch rotation is therefore incoherent on this substrate
    // (it can only ever clobber, never load-balance - 2026-06-25 doctrine), and
    // it was a recurring murder path for the live account. The scheduler no longer
    // rotates at all: it dispatches the worker onto whatever account is live. The
    // ONLY sanctioned account mover is the cap-watch/autoswitch -> account-switch.sh
    // canonical re-login, gated by the operator pin (<COORD_ROOT>/usage/account-pin).
    // Origin: 2026-06-29, status_board 3b604f2e. Prior sticky half-measure: f3e097c.
    //
    // Defer-on-all-capped guard (DETECTION ONLY, no rotation). Consult
    // pick_healthiest_account purely for its side effect: it throws
    // AllAccountsCappedError when every enabled account is capped, which the catch
    // below turns into a row deferral instead of spawning a worker onto a dead
    // account. Its RETURN value is deliberately discarded - dispatch runs on the
    // live account, never a picked one.
    await getCreds().pick_healthiest_account({ required_headroom_minutes: 1 })
    const liveShort = (() => { try { return getCreds().current_account() } catch (_) { return null } })()
    account = (liveShort && liveShort !== 'unknown') ? liveShort : 'current-process'

    // 2026-06-10 branch-thrash guard: allocate isolated worktree off origin/main
    // so the worker tab cannot flip the conductor's shared tree. Allocation
    // failure is non-fatal - we log it and proceed without a worktree path,
    // and the reference-transaction hook on the shared tree is the runtime
    // backstop in that case.
    let worktreePath = null
    try {
      worktreePath = await exports.allocateWorktreeForRow(row)
    } catch (e) {
      process.stderr.write('[scheduler] dispatchOne: worktree allocation failed for ' + row.id + ': ' + (e && e.message || e) + ' (dispatching without isolated worktree; branch-thrash guard now relies on the reference-transaction hook)\n')
    }

    // 2. Build brief with actual_account + worktree_path filled in.
    const rowWithAccount = Object.assign({}, row, { actual_account: account, worktree_path: worktreePath })
    const brief = exports.buildBrief(rowWithAccount)

    // 2c. Dispatch-start lease refresh + pre-spawn reclaim guard.
    // 2026-06-21 lease-aging-in-launch-lock-queue fix (the live 5-6h cron-fleet
    // stall: gmail-inbox-poll / calendar-watch / infra-health-pulse / status-board-
    // execute-top all sat status=dispatching retry_count=3, last_run_at frozen ~5h,
    // "stale lease recovered"). leased_at is stamped by leaseDueRows at QUEUE-ENTRY
    // time, but dispatchOne holds the SERIAL launch-lock across each bind (up to
    // SIGNAL_BOUND_TIMEOUT_MS). Under a due-row burst a row's leased_at ages past
    // STALE_DISPATCHING_MS (15min) WHILE STILL QUEUED behind the lock - before its
    // worker is ever spawned - so staleLeaseRecovery branch-1's liveness gate
    // (4cab6c3) cannot protect it (hasLiveWorkerForTask returns null: no worker
    // exists in coord yet). branch-1 reclaims it, and the eventual running-flip
    // no-ops (rowCount 0), leaving an ORPHAN tab that inflates active_workers,
    // forces rotation to defer, and collapses dispatch throughput into the spiral.
    // Refresh leased_at to NOW() HERE, at dispatch-start under the lock and as late
    // as possible before spawn (after the slow rotate_to + worktree alloc), so the
    // 15min stale window measures the actual bind duration (<=10min) with the
    // intended 5min headroom rather than the queue wait. Guarded on still owning
    // the lease: if the row was reclaimed/cancelled during account-rotation or
    // worktree prep, bail WITHOUT spawning a worker - preventing the orphan tab
    // entirely instead of discovering the loss after the spawn at the running-flip.
    const startGuard = await pool.query(
      `UPDATE os_scheduled_tasks
          SET leased_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND status = 'dispatching'
          AND leased_by IS NOT DISTINCT FROM $2`,
      [row.id, row.leased_by || null]
    )
    if (startGuard.rowCount === 0) {
      process.stderr.write('[scheduler] dispatchOne: row ' + row.id +
        ' lease lost during dispatch prep (reclaimed/cancelled before worker spawn); skipping spawn\n')
      return
    }

    // 3. Dispatch worker.
    const dispatcher = getDispatcher()
    const result = await dispatcher.dispatch_worker({
      brief: brief,
      task_id: String(row.id),
      ide: 'stable',
      // Set ack timeout to 0 so dispatch_worker returns immediately.
      // We do our own signal_bound wait below inside the launch-lock.
      worker_acknowledgment_timeout_ms: 0,
    })

    if (!result || !result.ok) {
      // 2026-05-29 ultracode audit H6 fix. When dispatch_worker spawns the
      // tab but fails to paste the brief, it returns {ok:false, orphan:true,
      // tab_id, tab_handle}. The tab is open + un-briefed + uncovered by any
      // sweep because dispatched_tab_id was never persisted. Clean it up
      // here before throwing so the next dispatch tick doesn't compound the
      // leak with a brand-new tab.
      if (result && result.orphan && result.tab_id) {
        try {
          await dispatcher.kill_worker({ tab_id: result.tab_id, tab_handle: result.tab_handle })
        } catch (e) {
          process.stderr.write('[scheduler] dispatchOne: orphan kill_worker error: ' + e.message + '\n')
        }
      }
      throw new Error('dispatch_worker failed: ' + (result && result.error || 'unknown'))
    }

    tabId = result.tab_id

    // 4. Wait for signal_bound (inside launch-lock).
    // Poll coord inbox for a message with body.type==='bound' && body.task_id === row.id
    const taskIdStr = String(row.id)
    const start = Date.now()
    let bound = false
    while (Date.now() - start < SIGNAL_BOUND_TIMEOUT_MS) {
      const inbox = await coord.peek_inbox({ topic: 'chat.conductor.inbox', limit: 50 })
      if (inbox && inbox.messages) {
        for (const msg of inbox.messages) {
          const body = msg.body
          if (body && body.type === 'bound' && String(body.task_id) === taskIdStr) {
            bound = true
            // 2026-05-29 ultracode audit H4 fix. Was read_inbox({limit:1})
            // which marks the OLDEST unread seen (not the matched bound -
            // bound arrives late, sorts last). Under back-to-back dispatch
            // the oldest unread is often a DIFFERENT task's done signal that
            // gets silently consumed, orphaning that task for 6h. Use
            // ack_message by id - addresses exactly the matched message.
            try { await coord.ack_message({ message_id: msg.id }) } catch (e) {}
            break
          }
        }
      }
      if (bound) break
      await new Promise(r => setTimeout(r, 1000))
    }

    // 5. Update row to running - GUARDED on still owning the lease.
    //
    // 2026-06-18 half-state race fix. The signal_bound wait above can run up to
    // SIGNAL_BOUND_TIMEOUT_MS (600s). If it overruns STALE_DISPATCHING_MS,
    // staleLeaseRecovery branch-1 fires on this still-'dispatching' row, sets
    // status='active', leased_by=NULL, retry_count++. The OLD unconditional
    // UPDATE then blindly overwrote status back to 'running' WITHOUT reclaiming
    // leased_by, producing the observed zombie half-state (status=running AND
    // leased_by IS NULL - a running row with no lease owner) and risking a
    // double-dispatch of the same task. Guarding on (status='dispatching' AND
    // leased_by unchanged) makes the flip a no-op when recovery already reclaimed
    // the row; we then bail and let the recovered row re-dispatch cleanly. Live
    // evidence 2026-06-18: external-blocker / client-app-health /
    // monthly-architectural-review all sat status=running, leased_by NULL,
    // leased_at SET, last_error='stale lease recovered'.
    const runRes = await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'running', actual_account = $1, dispatched_tab_id = $2,
           leased_at = NOW(), updated_at = NOW()
       WHERE id = $3
         AND status = 'dispatching'
         AND leased_by IS NOT DISTINCT FROM $4`,
      [account, tabId, row.id, row.leased_by || null]
    )

    if (runRes && runRes.rowCount === 0) {
      // Lease reclaimed mid-bind (or already advanced). Do NOT resurrect to
      // running - that is exactly the zombie half-state. The just-spawned tab,
      // if live, is reconciled by cleanup_orphan_workers; if the worker signals
      // done, the row is already back in the active->dispatch cycle.
      process.stderr.write('[scheduler] dispatchOne: lease for task ' + row.id +
        ' was reclaimed during signal_bound wait (tab ' + tabId +
        '); skipping running-flip to avoid zombie half-state\n')
      return
    }

    if (!bound) {
      process.stderr.write('[scheduler] dispatchOne: signal_bound timeout for task ' + row.id + ' (tab ' + tabId + ')\n')
    }
  } catch (err) {
    const errMsg = err && err.message || ''
    if (err && err.name === 'AllAccountsCappedError') {
      // Defer: find earliest reset + 1min, release lease, keep status=active.
      let deferMs = 60 * 60 * 1000  // default 1h
      if (err.resets) {
        const times = Object.values(err.resets)
          .filter(Boolean)
          .map(t => new Date(t).getTime())
          .filter(t => !isNaN(t))
        if (times.length > 0) {
          deferMs = Math.min(...times) - Date.now() + 60_000
          if (deferMs < 60_000) deferMs = 60_000
        }
      }
      const nextRun = new Date(Date.now() + deferMs)
      try {
        await pool.query(
          `UPDATE os_scheduled_tasks
           SET status = 'active', leased_by = NULL, leased_at = NULL,
               next_run_at = $1, last_error = $2, updated_at = NOW()
           WHERE id = $3`,
          [nextRun.toISOString(), 'AllAccountsCappedError - deferred ' + Math.round(deferMs / 60000) + 'min', row.id]
        )
      } catch (pgErr) {
        process.stderr.write('[scheduler] markFailed pg error: ' + pgErr.message + '\n')
      }
    } else if (exports.isTransientBridgeError(errMsg)) {
      // 2026-06-02 P0 fix, broadened 2026-06-20 (audit finding c). The
      // dispatch_worker editor.open path throws a transient error when no IDE has
      // registered the bridge ("no IDE instances registered") OR when the bridge
      // socket blips mid-open ("populate failed (editor.open): socket hang up",
      // ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE). All are TRANSIENT infra
      // unavailability (Tate closes the IDE, machine sleeps, extension reloads,
      // bridge restarts), not a task fault. Treat like AllAccountsCappedError:
      // defer ~5min, do NOT increment retry_count, do NOT mark failed - for cron
      // AND one-shot/delayed rows alike (the latter would otherwise burn retries
      // to a permanent status='failed' on a transient blip and silently lose the
      // scheduled work). The row survives the gap window naturally.
      const deferMs = 5 * 60 * 1000
      const nextRun = new Date(Date.now() + deferMs)
      try {
        await pool.query(
          `UPDATE os_scheduled_tasks
           SET status = 'active', leased_by = NULL, leased_at = NULL,
               next_run_at = $1, last_error = $2, updated_at = NOW()
           WHERE id = $3`,
          [nextRun.toISOString(), 'transient IDE-bridge error - deferred 5min (' + errMsg.slice(0, 80) + ')', row.id]
        )
      } catch (pgErr) {
        process.stderr.write('[scheduler] transient-bridge defer pg error: ' + pgErr.message + '\n')
      }
    } else {
      try {
        await exports.markFailed(row, err)
      } catch (pgErr) {
        process.stderr.write('[scheduler] markFailed pg error: ' + pgErr.message + '\n')
      }
    }
    // Re-throw so the caller knows this row failed.
    throw err
  } finally {
    // Always release the launch-lock.
    release()
  }
}

// ── markComplete ─────────────────────────────────────────────────────────────
//
// Called when a running task signals done. Handles cron reschedule or
// one_shot completion. Tolerates close_tab failures.

exports.markComplete = async function markComplete(row, signal) {
  const pool = getPool()
  const dispatcher = getDispatcher()

  // 2026-06-10 branch-thrash guard cleanup: drop the per-row isolated worktree
  // allocated at dispatchOne. Idempotent + tolerant so a missing worktree
  // (legacy row from before the guard shipped, or one already pruned by a
  // recovery sweep) does not block completion.
  try { await exports.pruneWorktreeForRow(row) } catch (_e) {}

  // 2026-05-29 ultracode audit H2 fix. Was: kill_worker in try/catch then
  // unconditional dispatched_tab_id = NULL. kill_worker returns ok:true even
  // when it refuses, so the NULL hid the leak and discarded the only handle
  // for a later sweep. Now: only NULL the column when the kill actually
  // closed the tab. Retained handles are reconcilable by
  // cleanup_orphan_workers (which runs every CLEANUP_ORPHAN_INTERVAL_MS).
  let closeOk = false
  if (row.dispatched_tab_id) {
    try {
      if (dispatcher.kill_worker) {
        const killRes = await dispatcher.kill_worker({ tab_id: row.dispatched_tab_id })
        closeOk = !!(killRes && killRes.closed)
      }
    } catch (e) {
      process.stderr.write('[scheduler] kill_worker tolerated error: ' + e.message + '\n')
    }
  }
  const dispatchedTabIdSqlFrag = closeOk ? 'dispatched_tab_id = NULL,' : ''

  // 2026-06-09: missing status === success. Pre-fix, coord.signal_done was
  // dropping params.status on the way to the inbox, so signal.status came
  // through as undefined and every signal_done was misclassified as failure.
  // Defensive default: a worker calling signal_done at all is the affirmative
  // "I finished" signal; only an EXPLICIT signal.status === 'failed' (or any
  // non-success value) should route through markFailed. See
  // [[scheduler-signal-done-status-must-survive-coord-to-inbox-2026-06-09]].
  const explicitFailure = signal && signal.status && signal.status !== 'success'

  if (explicitFailure) {
    // Treat as failure: delegate to markFailed with a synthetic error.
    const syntheticErr = new Error(
      (signal && signal.result_summary) || 'task signaled non-success'
    )
    syntheticErr.message = (signal && signal.result_summary) || 'task signaled non-success'
    return exports.markFailed(row, syntheticErr)
  }

  const rowType = row.type || 'one_shot'

  if (rowType === 'cron' && row.cron_expression) {
    // Compute next_run_at via cron-parser using the row's tz (default Brisbane).
    // Pre-2026-05-31 this was hardcoded {utc:true}, which mis-fired AEST schedules
    // by 10h. Phase A1 unification: every cron carries its own tz column.
    let nextRunAt = null
    try {
      nextRunAt = exports.computeNextRunAt(row)
    } catch (cronErr) {
      process.stderr.write('[scheduler] cron-parser error for "' + row.cron_expression + '": ' + cronErr.message + '\n')
    }
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', last_run_at = NOW(), next_run_at = $1,
           run_count = run_count + 1, last_result = $2,
           retry_count = 0, leased_by = NULL, leased_at = NULL,
           ${dispatchedTabIdSqlFrag} updated_at = NOW()
       WHERE id = $3
         AND archived_at IS NULL
         AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
      [nextRunAt, String((signal && signal.result_summary) || '').slice(0, 2000), row.id]
    )
  } else {
    // one_shot or delayed: mark completed.
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'completed', last_run_at = NOW(), last_result = $1,
           run_count = run_count + 1, leased_by = NULL, leased_at = NULL,
           ${dispatchedTabIdSqlFrag} updated_at = NOW()
       WHERE id = $2`,
      [String((signal && signal.result_summary) || '').slice(0, 2000), row.id]
    )
  }

  // 2026-06-01 Phase A2: chain wake-up. Any child row with chain_after = parent.id
  // gets next_run_at=NOW() so the dispatch loop picks it up on the next 30s poll.
  // Only fires on success - chain children stay parked if the parent failed.
  // 2026-06-10: ReferenceError fix. Was `if (isSuccess)` referencing an undeclared
  // variable, throwing on every completionPass markComplete and caught by the outer
  // try/catch. !explicitFailure is the correct success predicate at this point
  // (explicitFailure path already returned early via markFailed above).
  if (!explicitFailure) {
    try {
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET next_run_at = NOW(), updated_at = NOW()
         WHERE chain_after = $1
           AND status = 'active'
           AND archived_at IS NULL
           AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
        [row.id]
      )
    } catch (chainErr) {
      process.stderr.write('[scheduler] chain wake-up error for parent ' + row.id + ': ' + chainErr.message + '\n')
    }
  }
}

// ── completionPass ───────────────────────────────────────────────────────────
//
// Checks coord inbox for done signals from running tasks and completes them.
// Non-destructive: uses peek_inbox to scan, then targeted read_inbox to consume.

exports.completionPass = async function completionPass() {
  const pool = getPool()

  // Fetch all running rows (need leased_at for the freshness gate below).
  const result = await pool.query(
    `SELECT * FROM os_scheduled_tasks WHERE status = 'running' LIMIT 50`
  )
  if (!result.rows.length) return

  // 2026-06-18 scheduler-completion-race fix. Was: coord.peek_inbox on
  // chat.conductor.inbox, which only returns UNSEEN messages. The interactive
  // conductor reads the SAME inbox via coord.read_inbox (its wake /
  // UserPromptSubmit hook), which marks a worker's `done` signal seen within
  // ~1s of arrival. completionPass (every 5s) then lost the race: the done was
  // already seen, and peek_inbox can never return a seen message, so
  // markComplete never fired and the row rotted in status=running until the 6h
  // orphan timer. Live evidence 2026-06-18: external-blocker-freshness-probe
  // done created 06:23:38.505Z, marked seen 06:23:39.117Z (0.6s later), row
  // still running 4h on. Fix: scan the FULL inbox index (seen or unseen) for the
  // newest done per running task_id - completion detection is now independent of
  // whoever else drains the inbox. See
  // [[scheduler-completion-must-not-share-seen-flag-with-conductor-inbox-2026-06-18]].
  const runningIds = result.rows.map(r => String(r.id))
  let doneByTask
  try {
    doneByTask = coord.scanTopicByType('chat.conductor.inbox', 'done', runningIds)
  } catch (e) {
    process.stderr.write('[scheduler] completionPass scan error: ' + e.message + '\n')
    return
  }
  if (!doneByTask || !doneByTask.size) return

  for (const row of result.rows) {
    const msg = doneByTask.get(String(row.id))
    if (!msg) continue
    // Freshness gate. task_id == row.id is STABLE across cron fires, so the
    // inbox accumulates many done signals with the same task_id over a row's
    // lifetime. Only THIS dispatch's done counts: leased_at is set to NOW() when
    // dispatchOne flips the row to running, so a prior fire's done has
    // created_at < leased_at and must be ignored (else a fresh dispatch would be
    // completed instantly by a days-old signal, before its worker even runs).
    // 30s back-margin tolerates a fast worker that signals done microseconds
    // before the running-flip timestamp; cron intervals are >= minutes and
    // one-shot task_ids are unique, so no cross-fire collision fits that margin.
    //
    // 2026-07-08 phantom-completion-class guard. A legitimately-running row
    // ALWAYS carries a lease: dispatchOne stamps leased_at = NOW() when it flips
    // the row to running (line ~812) and refreshes it at dispatch-start. A
    // running row with leased_at IS NULL is a half-state (a recovery race per the
    // 2026-06-18 dispatch half-state note), NOT a completable run. The prior gate
    // was `if (row.leased_at) { freshness-check }` - a NULL leased_at SKIPPED the
    // check entirely, so ANY matching done in the inbox would complete the row.
    // Because task_id == row.id is STABLE across cron fires, a stale prior-fire
    // done could then flip an unleased running row to completed with no worker
    // having run this dispatch - the phantom-completion class. Require a lease
    // before completing; freshness-gate against it; leave an unleased running row
    // for staleLeaseRecovery's orphan path. See
    // [[scheduler-completion-must-not-share-seen-flag-with-conductor-inbox-2026-06-18]].
    if (!row.leased_at) {
      process.stderr.write('[scheduler] completionPass: skip unleased running row ' + row.id + ' (leased_at NULL; leaving for staleLeaseRecovery)\n')
      continue
    }
    const doneMs = new Date(msg.created_at).getTime()
    const leasedMs = new Date(row.leased_at).getTime()
    if (!isNaN(doneMs) && !isNaN(leasedMs) && doneMs < leasedMs - 30_000) continue
    try {
      await exports.markComplete(row, msg.body)
    } catch (e) {
      process.stderr.write('[scheduler] completionPass markComplete error for ' + row.id + ': ' + e.message + '\n')
    }
  }
}

// ── staleLeaseRecovery ───────────────────────────────────────────────────────
//
// Three SQL updates per the plan:
//   1. dispatching > STALE_DISPATCHING_MS and retry_count < MAX_RETRY_COUNT -> active, retry_count++
//   2. dispatching > STALE_DISPATCHING_MS and retry_count >= MAX_RETRY_COUNT -> failed
//   3. running > ORPHAN_TIMEOUT_MS -> orphaned

// Liveness staleness window: a worker whose last heartbeat was within
// STALE_WORKER_LIVENESS_MS counts as alive for the stale-lease skip path.
// 180s matches the existing scheduler.SIGNAL_BOUND_TIMEOUT_MS cold-start
// p90 floor and the cowork heartbeat cadence. Hardcoding lower than the
// observed cold-start floor is an anti-pattern: a slow bind would look
// dead and let the scheduler thunder-herd the same row.
const STALE_WORKER_LIVENESS_MS = 180_000

async function hasLiveWorkerForTask(taskId) {
  try {
    const r = await getCoord().list_workers({})
    const ws = (r && r.workers) || []
    for (const w of ws) {
      if (w.task_id !== taskId) continue
      if (w.terminated_at) continue
      if (w.dead) continue
      if (typeof w.stale_ms === 'number' && w.stale_ms >= STALE_WORKER_LIVENESS_MS) continue
      return w
    }
    return null
  } catch (e) {
    // Fail-open: if coord is unreachable, do not block stale-lease recovery.
    // A stuck recovery loop is worse than a single thundering-herd re-dispatch.
    process.stderr.write('[scheduler] hasLiveWorkerForTask coord error for ' + taskId + ': ' + e.message + '\n')
    return null
  }
}

exports.staleLeaseRecovery = async function staleLeaseRecovery() {
  const pool = getPool()

  // 1. Stale dispatching, retryable. 2026-06-21 reclaim-vs-bind race fix
  // (status_board 128b7c82): converted from a bulk UPDATE to SELECT + per-row
  // UPDATE so this branch consults coord worker liveness BEFORE reclaiming, exactly
  // as branches 2a/2b/3 already do. The bulk form reclaimed ANY dispatching row
  // whose leased_at aged past STALE_DISPATCHING_MS (15min) with NO liveness check,
  // but the observed p99 cold-bind tail (~21min, see the SIGNAL_BOUND_TIMEOUT_MS
  // note above) EXCEEDS that window: a slow-but-live worker still inside its
  // legitimate bind / early-work window had its lease freed, next_run_at re-armed,
  // retry_count bumped, and the next 30s poll re-dispatched the SAME task while the
  // first worker was still alive. dispatchOne's running-flip guard only blocks the
  // zombie half-state; it does NOT stop the duplicate re-dispatch, so the fleet
  // thrashed ('stale lease recovered' grew to 48 active rows 2026-06-20 even after
  // a mitigation restart). Per [[enumerate-all-trigger-paths-when-fixing-data-flow-bugs]]
  // a guard wired into N parallel branches must cover ALL branches of the same
  // routine; branch 1 was the one staleLeaseRecovery branch the liveness gate was
  // never wired into (the comment in branch 3 below even mis-stated it as already
  // covering "branches 1 + 2a + 2b"). A genuinely dead worker (heartbeat stale
  // >= STALE_WORKER_LIVENESS_MS, or no worker row at all) still reclaims. next_run_at
  // re-arm is unchanged: BOUNDED retry backoff per RETRY_BACKOFF_MS +
  // [[cron-rearm-must-recompute-next-run-at-or-guard-reentry-per-period-2026-06-19]].
  const staleRetryableRows = await pool.query(
    `SELECT id, name FROM os_scheduled_tasks
     WHERE status = 'dispatching'
       AND leased_at < NOW() - ($1 || ' milliseconds')::interval
       AND retry_count < $2
       AND archived_at IS NULL
       AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
    [STALE_DISPATCHING_MS, MAX_RETRY_COUNT]
  )
  for (const row of staleRetryableRows.rows) {
    const liveWorker = await hasLiveWorkerForTask(row.id)
    if (liveWorker) {
      process.stderr.write(
        '[scheduler] task ' + row.id + ' has live worker ' + liveWorker.tab_id +
        ' (stale_ms=' + liveWorker.stale_ms + '), skipping stale-lease retry reclaim\n'
      )
      continue
    }
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', retry_count = retry_count + 1,
           last_error = 'stale lease recovered (next_run_at re-armed to bounded retry backoff)',
           next_run_at = NOW() + ($2 || ' milliseconds')::interval,
           leased_by = NULL, leased_at = NULL, updated_at = NOW()
       WHERE id = $1
         AND status = 'dispatching'
         AND archived_at IS NULL
         AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
      [row.id, RETRY_BACKOFF_MS]
    )
  }

  // 2a. Stale dispatching, max retries exhausted, CRON row: defer to next
  // scheduled interval and reset retry_count per
  // [[scheduler-no-ide-defer-and-cron-rows-never-permanently-fail-2026-06-02]].
  // Marking a cron row permanently failed loses every future interval of
  // recurring work. markFailed already handles this for the dispatchOne path;
  // this branch fixes the parallel path through the stale-lease sweep.
  const staleCronRows = await pool.query(
    `SELECT id, cron_expression, tz FROM os_scheduled_tasks
     WHERE status = 'dispatching'
       AND leased_at < NOW() - ($1 || ' milliseconds')::interval
       AND retry_count >= $2
       AND type = 'cron'
       AND cron_expression IS NOT NULL`,
    [STALE_DISPATCHING_MS, MAX_RETRY_COUNT]
  )
  for (const row of staleCronRows.rows) {
    // Liveness gate per
    // [[scheduler-stale-lease-must-check-coord-worker-liveness-before-redispatch-2026-06-10]].
    // If a worker tab is still heartbeating against this task, skip the
    // re-dispatch and leave leased_by + leased_at intact so the lease keeps
    // holding. Freeing the lease here is the thundering-herd anti-pattern
    // (origin: 2026-06-10T04:23Z, telemetry-batch fired 4 sibling workers
    // inside 4 min because cold-start binds breached STALE_DISPATCHING_MS).
    const liveWorker = await hasLiveWorkerForTask(row.id)
    if (liveWorker) {
      process.stderr.write(
        '[scheduler] task ' + row.id + ' has live worker ' + liveWorker.tab_id +
        ' (stale_ms=' + liveWorker.stale_ms + '), skipping stale-lease cron-defer\n'
      )
      continue
    }
    let nextRunAt = null
    try {
      nextRunAt = exports.computeNextRunAt(row)
    } catch (_e) {
      nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', retry_count = 0,
           last_error = 'stale lease - max retries exhausted (cron: deferred to next interval per doctrine)',
           next_run_at = $1, leased_by = NULL, leased_at = NULL, updated_at = NOW()
       WHERE id = $2
         AND archived_at IS NULL
         AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
      [nextRunAt, row.id]
    )
    // 2026-06-10 branch-thrash guard cleanup on cron-defer recovery.
    try { await exports.pruneWorktreeForRow(row) } catch (_e) {}
  }

  // 2b. Stale dispatching, max retries exhausted, NON-CRON row: permanently
  // fail. One-shot delayed work is genuinely done after 3 stale leases.
  // Converted from a single bulk UPDATE to SELECT + per-row UPDATE on
  // 2026-06-10 so the coord-liveness gate can consult per task_id. The
  // bulk UPDATE could not consult coord per row and re-dispatched mid-flight
  // workers (incident 2026-06-10T04:23Z, telemetry-batch).
  const staleNonCronRows = await pool.query(
    `SELECT id FROM os_scheduled_tasks
     WHERE status = 'dispatching'
       AND leased_at < NOW() - ($1 || ' milliseconds')::interval
       AND retry_count >= $2
       AND (type != 'cron' OR cron_expression IS NULL)`,
    [STALE_DISPATCHING_MS, MAX_RETRY_COUNT]
  )
  for (const row of staleNonCronRows.rows) {
    const liveWorker = await hasLiveWorkerForTask(row.id)
    if (liveWorker) {
      process.stderr.write(
        '[scheduler] task ' + row.id + ' has live worker ' + liveWorker.tab_id +
        ' (stale_ms=' + liveWorker.stale_ms + '), skipping stale-lease fail\n'
      )
      continue
    }
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'failed', retry_count = retry_count + 1,
           last_error = 'stale lease - max retries exhausted',
           leased_by = NULL, leased_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [row.id]
    )
    // 2026-06-10 branch-thrash guard cleanup on permanent fail.
    try { await exports.pruneWorktreeForRow(row) } catch (_e) {}
  }

  // 3. Running too long -> orphaned (non-cron) OR deferred to next interval (cron).
  //
  // 2026-05-29 ultracode audit H3 fix. Was: status='orphaned' only. The
  // orphan row's dispatched_tab_id was never cleaned, and startupCleanup
  // filters on last_run_at > NOW() - 24h - orphan rows have stale/null
  // last_run_at so they were permanently excluded. Tab leaked forever.
  // Now: identify orphans, kill_worker on each (best-effort), gate the
  // tab_id NULL on closed:true (mirrors markComplete), and set last_run_at
  // so a future startupCleanup or cleanup_orphan_workers sweep can still
  // target the stored tab_handle on disk.
  //
  // 2026-06-09 fix: cron rows in this branch were also being permanently
  // terminated as 'orphaned', stranding 23 corpus rows after the 24h
  // signal_bound regression window (08-09 June). Per
  // [[scheduler-no-ide-defer-and-cron-rows-never-permanently-fail-2026-06-02]],
  // cron rows must defer to their next scheduled interval; only one-shot
  // (delayed/chained) rows go to terminal status='orphaned'.
  // 2026-06-22 cadence-aware window: a stuck-running CRON row is eligible after
  // RUNNING_CRON_ORPHAN_MS (30min); a one-shot (non-cron) keeps the 6h
  // ORPHAN_TIMEOUT_MS. Both still pass through the per-row liveness gate below,
  // so this only TIGHTENS eligibility for fast crons, never bypasses the gate.
  const orphans = await pool.query(
    `SELECT id, dispatched_tab_id, type, cron_expression, tz FROM os_scheduled_tasks
     WHERE status = 'running'
       AND (
         (type = 'cron' AND cron_expression IS NOT NULL
            AND leased_at < NOW() - ($1 || ' milliseconds')::interval)
         OR
         ((type <> 'cron' OR cron_expression IS NULL)
            AND leased_at < NOW() - ($2 || ' milliseconds')::interval)
       )`,
    [RUNNING_CRON_ORPHAN_MS, ORPHAN_TIMEOUT_MS]
  )
  const dispatcher = getDispatcher()
  for (const row of orphans.rows) {
    // Liveness gate per
    // [[scheduler-stale-lease-must-check-coord-worker-liveness-before-redispatch-2026-06-10]].
    // 2026-06-18: the 2026-06-10 fix wired this gate into branches 1 + 2a + 2b
    // (the status='dispatching' sweeps) but MISSED this branch 3 (the
    // status='running' orphan-timeout sweep). A cron worker still heartbeating
    // but running past ORPHAN_TIMEOUT_MS (6h) had its row flipped back to
    // 'active' with a fresh next_run_at WITHOUT a liveness check, so the next
    // poll re-leased (re-dispatched) the task while the prior tab was still
    // finishing. That is the exact double-fire path behind the morning dup
    // bursts (climate-pm-chain + orphan-next-action-audit) and the
    // partnership-watering double-dispatch on 2026-06-14. When a worker tab is
    // still alive for this task, SKIP the reclaim and leave status='running' +
    // leased_by + leased_at intact so the lease keeps holding (mirrors the
    // skip in branches 2a + 2b). Once heartbeats stop, hasLiveWorkerForTask
    // returns null within STALE_WORKER_LIVENESS_MS and the next sweep reclaims.
    // Doctrine: [[enumerate-all-trigger-paths-when-fixing-data-flow-bugs]] -
    // a guard wired into N parallel branches must cover ALL branches of the
    // same routine.
    const liveWorker = await hasLiveWorkerForTask(row.id)
    if (liveWorker) {
      process.stderr.write(
        '[scheduler] task ' + row.id + ' has live worker ' + liveWorker.tab_id +
        ' (stale_ms=' + liveWorker.stale_ms + '), skipping running orphan-timeout reclaim\n'
      )
      continue
    }
    let closeOk = false
    if (row.dispatched_tab_id && dispatcher.kill_worker) {
      try {
        const r = await dispatcher.kill_worker({ tab_id: row.dispatched_tab_id })
        closeOk = !!(r && r.closed)
      } catch (e) {
        process.stderr.write('[scheduler] orphan kill_worker tolerated error for ' + row.id + ': ' + e.message + '\n')
      }
    }
    const tabFrag = closeOk ? 'dispatched_tab_id = NULL,' : ''
    if (row.type === 'cron' && row.cron_expression) {
      let nextRunAt = null
      try {
        nextRunAt = exports.computeNextRunAt(row)
      } catch (_e) {
        nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'active', retry_count = 0, last_run_at = NOW(),
             next_run_at = $1,
             last_error = 'running orphan-timeout (cron: deferred to next interval per doctrine)',
             leased_by = NULL, leased_at = NULL, ${tabFrag} updated_at = NOW()
         WHERE id = $2
           AND archived_at IS NULL
           AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))`,
        [nextRunAt, row.id]
      )
    } else {
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'orphaned', last_run_at = NOW(), ${tabFrag} updated_at = NOW()
         WHERE id = $1`,
        [row.id]
      )
    }
    // 2026-06-10 branch-thrash guard cleanup on orphan + cron-defer paths.
    try { await exports.pruneWorktreeForRow(row) } catch (_e) {}
  }
}

// ── runCountAnomalyAudit ─────────────────────────────────────────────────────
//
// Dispatcher self-audit canary. Scans non-archived cron rows and flags any whose
// lifetime run_count is implausibly high for the row's age given its schedule
// (e.g. an annual cron created two weeks ago with run_count > 1). This is the
// observability that turns the off-cadence re-fire bug from "found at the monthly
// review" into "alarmed on day one". Read-only; returns the anomaly list and logs
// each to stderr so the scheduler-health canary / log drain surfaces it. Per
// [[cron-rearm-must-recompute-next-run-at-or-guard-reentry-per-period-2026-06-19]]
// fix #3 and [[scheduler-health-canary-and-cron-dupe-guard-2026-06-10]].
exports.runCountAnomalyAudit = async function runCountAnomalyAudit() {
  const pool = getPool()
  const ref = new Date()
  let rows
  try {
    const r = await pool.query(
      `SELECT id, name, type, cron_expression, tz, run_count, created_at
         FROM os_scheduled_tasks
        WHERE type = 'cron'
          AND cron_expression IS NOT NULL
          AND archived_at IS NULL
          AND (last_status IS NULL OR last_status NOT IN ('cancelled'))`
    )
    rows = r.rows
  } catch (e) {
    process.stderr.write('[scheduler] runCountAnomalyAudit query error: ' + e.message + '\n')
    return []
  }
  const anomalies = []
  for (const row of rows) {
    const a = exports.runCountAnomalyForRow(row, ref)
    if (a && a.anomalous) {
      anomalies.push(a)
      process.stderr.write(
        '[scheduler] RUN_COUNT ANOMALY ' + a.id + ' (' + (a.name || '?') + '): run_count=' +
        a.runCount + ' expectedMax=' + a.expectedMax + ' periodMs=' + a.periodMs +
        ' ageDays=' + (a.ageMs / 86400000).toFixed(1) + ' - off-cadence re-fire fingerprint\n'
      )
    }
  }
  return anomalies
}

// ── startupCleanup ───────────────────────────────────────────────────────────
//
// On boot, find recently completed/failed/orphaned rows that still have a
// dispatched_tab_id and try to close those tabs + null out the column.
// Tolerate all errors - cleanup is best-effort.

exports.startupCleanup = async function startupCleanup() {
  let rows = []
  try {
    const pool = getPool()
    const result = await pool.query(
      `SELECT id, dispatched_tab_id FROM os_scheduled_tasks
       WHERE status IN ('completed', 'failed', 'orphaned')
         AND last_run_at > NOW() - INTERVAL '24 hours'
         AND dispatched_tab_id IS NOT NULL
       LIMIT 20`
    )
    rows = result.rows
  } catch (e) {
    process.stderr.write('[scheduler] startupCleanup query error: ' + e.message + '\n')
    return
  }

  const dispatcher = getDispatcher()
  for (const row of rows) {
    let closeOk = false
    try {
      if (dispatcher.kill_worker) {
        const r = await dispatcher.kill_worker({ tab_id: row.dispatched_tab_id })
        closeOk = !!(r && r.closed)
      }
    } catch (e) {
      // Tolerate - tab may already be closed.
    }
    if (!closeOk) continue  // 2026-05-29 H2: retain handle so the cleanup sweep can target it
    try {
      const pool = getPool()
      await pool.query(
        `UPDATE os_scheduled_tasks SET dispatched_tab_id = NULL, updated_at = NOW() WHERE id = $1`,
        [row.id]
      )
    } catch (e) {
      process.stderr.write('[scheduler] startupCleanup update error for ' + row.id + ': ' + e.message + '\n')
    }
  }
}

// ── usage-cap observer (Phase 7) ─────────────────────────────────────────────
//
// Every 5 minutes, checks the current account's headroom. If it is below
// HEADROOM_WARN_THRESHOLD_MIN, writes an observer_signals row so any active CC
// chat sees the warning in its <observer_signals> continuity block on the next
// turn. Anti-spam: 1-hour cooldown per current-account fingerprint.

const HEADROOM_WARN_THRESHOLD_MIN = 15
const CAP_OBSERVER_INTERVAL_MS = 5 * 60 * 1000
const CAP_OBSERVER_COOLDOWN_MS = 60 * 60 * 1000

let _usageModule = null
function getUsageModule() {
  if (!_usageModule) _usageModule = require('./usage')
  return _usageModule
}
exports._setUsageModule = function (mod) { _usageModule = mod }

const _capWarningLast = { account: null, at: 0 }

exports.checkCapWarning = async function checkCapWarning() {
  const current = getCreds().current_account()
  if (current === 'unknown') return { skipped: 'no_current_account' }

  const usage = getUsageModule()
  const stateResult = await usage.get_usage_state({})
  const accountState = stateResult && stateResult.state && stateResult.state[current]
  if (!accountState) return { skipped: 'no_state_for_current' }

  const headroomMin = typeof accountState.headroom_minutes === 'number'
    ? accountState.headroom_minutes
    : (typeof accountState.remaining_minutes === 'number' ? accountState.remaining_minutes : null)

  if (headroomMin === null || headroomMin > HEADROOM_WARN_THRESHOLD_MIN) {
    return { skipped: 'headroom_ample', headroom_min: headroomMin }
  }

  const now = Date.now()
  if (_capWarningLast.account === current && (now - _capWarningLast.at) < CAP_OBSERVER_COOLDOWN_MS) {
    return { skipped: 'cooldown', cooldown_remaining_ms: CAP_OBSERVER_COOLDOWN_MS - (now - _capWarningLast.at) }
  }

  let nextAccount = null
  let nextHeadroom = null
  try {
    nextAccount = await getCreds().pick_healthiest_account({ required_headroom_minutes: 30 })
    if (nextAccount && nextAccount !== current) {
      const nextState = stateResult.state[nextAccount]
      if (nextState) {
        nextHeadroom = typeof nextState.headroom_minutes === 'number'
          ? nextState.headroom_minutes
          : nextState.remaining_minutes
      }
    } else {
      nextAccount = null
    }
  } catch (_e) {
    nextAccount = null
  }

  const message = nextAccount
    ? `Current account (${current}) is capping in ${Math.floor(headroomMin)} minutes. Next-healthiest account (${nextAccount}) has ${nextHeadroom ? Math.floor(nextHeadroom) : '?'} minutes of headroom. When convenient, finish your turn and open a new chat - it will land on ${nextAccount} automatically.`
    : `Current account (${current}) is capping in ${Math.floor(headroomMin)} minutes. All other accounts are also low. Reduce non-urgent work until reset.`

  const fingerprint = `usage_cap:${current}:${Math.floor(headroomMin / 5) * 5}m`

  await getPool().query(
    `INSERT INTO observer_signals (observer_name, signal_kind, message, fingerprint, priority, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    ['autonomy-substrate-usage-cap-observer', 'usage_cap_warning', message, fingerprint, 2]
  )

  _capWarningLast.account = current
  _capWarningLast.at = now
  return { fired: true, current, next: nextAccount, headroom_min: headroomMin }
}

exports._resetCapWarningLast = function () { _capWarningLast.account = null; _capWarningLast.at = 0 }

// ── CRUD MCP handlers (Phase A1: scheduler unification) ─────────────────────
//
// Three tools exposed as scheduler.schedule_delayed / scheduler.schedule_cron /
// scheduler.schedule_list. They write to os_scheduled_tasks and the existing
// dispatch engine (leaseDueRows -> dispatchOne) picks them up untouched.
//
// All times returned as both _utc (ISO) and _aest (AEST ISO) per the
// UTC-for-machines, AEST-for-Tate doctrine.

const AEST_OFFSET_HOURS = 10  // UTC+10, no DST in Brisbane

function toAestIso(dateLike) {
  if (!dateLike) return null
  const d = (dateLike instanceof Date) ? dateLike : new Date(dateLike)
  if (isNaN(d.getTime())) return null
  const shifted = new Date(d.getTime() + AEST_OFFSET_HOURS * 60 * 60 * 1000)
  return shifted.toISOString().replace('Z', '+10:00')
}

// Parse a delay string into an absolute Date.
//   'in 30m' / 'in 2h' / 'in 3d' / 'in 45s'
//   raw ISO 8601: '2026-06-01T15:00:00Z'
//   numeric ms-from-now: number (seconds-as-number rejected to force unit)
function parseDelay(delay) {
  if (delay == null) throw new Error('delay required')
  if (delay instanceof Date) return delay
  if (typeof delay === 'string') {
    const m = delay.match(/^\s*in\s+(\d+)\s*([smhd])\s*$/i)
    if (m) {
      const n = parseInt(m[1], 10)
      const unit = m[2].toLowerCase()
      const mult = unit === 's' ? 1000
        : unit === 'm' ? 60 * 1000
        : unit === 'h' ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000
      return new Date(Date.now() + n * mult)
    }
    // Try as ISO 8601.
    const iso = new Date(delay)
    if (!isNaN(iso.getTime())) return iso
    throw new Error('delay must be "in <N>[smhd]" or ISO 8601, got: ' + delay)
  }
  throw new Error('delay must be string, got: ' + typeof delay)
}

// Translate friendly schedule strings to raw cron-expressions.
//   'every 1h' / 'every 30m' / 'every 10s' (every <N>[smh])
//   'daily 09:00' / 'daily 23:30'
//   already-raw 5- or 6-field cron: passes through
// Back-compat shim. The real schedule semantics live in scheduleCore now; this
// only survives for external callers/tests that expect the cron STRING form of a
// cron-kind schedule. Intervals ("every 72h") are NOT cron, so the shim returns
// them unchanged rather than faking a (broken) "0 */N * * *". Internal next-run
// computation no longer goes through here; it uses scheduleCore directly.
function parseSchedule(schedule) {
  if (!schedule || typeof schedule !== 'string') {
    throw new Error('schedule required (string)')
  }
  const c = scheduleCore.classify(schedule)
  if (c && c.kind === 'cron') return c.cron
  return schedule.trim()
}
exports.parseSchedule = parseSchedule

const VALID_PRIORITY_CLASSES = new Set(['normal', 'high', 'low'])
function normalisePriorityClass(pc) {
  if (pc == null || pc === '') return 'normal'
  const v = String(pc).toLowerCase()
  if (v === 'high_fork' || v === 'low_fork') {
    throw new Error('priority_class ' + pc + ' references dead fork substrate; use "normal", "high", or "low"')
  }
  if (!VALID_PRIORITY_CLASSES.has(v)) {
    throw new Error('priority_class must be one of normal|high|low, got: ' + pc)
  }
  return v
}

// Map priority_class -> priority int (1=highest .. 5=lowest).
function priorityForClass(pc) {
  if (pc === 'high') return 1
  if (pc === 'low') return 5
  return 3
}

exports.schedule_delayed = async function schedule_delayed(params) {
  const p = params || {}
  if (!p.name || typeof p.name !== 'string') throw new Error('name required (string)')
  if (!p.prompt || typeof p.prompt !== 'string') throw new Error('prompt required (string)')
  const runAt = parseDelay(p.delay)
  const priorityClass = normalisePriorityClass(p.priority_class)
  const priority = priorityForClass(priorityClass)
  const tz = p.tz || 'Australia/Brisbane'

  const pool = getPool()
  const sql = `
    INSERT INTO os_scheduled_tasks
      (type, name, prompt, run_at, next_run_at, preferred_account, priority, tz, status)
    VALUES ('delayed', $1, $2, $3, $3, $4, $5, $6, 'active')
    RETURNING id, run_at, next_run_at, tz
  `
  const result = await pool.query(sql, [
    p.name,
    p.prompt,
    runAt.toISOString(),
    p.preferred_account || null,
    priority,
    tz,
  ])
  const row = result.rows[0]
  return {
    ok: true,
    id: row.id,
    type: 'delayed',
    priority_class: priorityClass,
    next_fire_at_utc: new Date(row.next_run_at).toISOString(),
    next_fire_at_aest: toAestIso(row.next_run_at),
  }
}

exports.schedule_cron = async function schedule_cron(params) {
  const p = params || {}
  if (!p.name || typeof p.name !== 'string') throw new Error('name required (string)')
  if (!p.prompt || typeof p.prompt !== 'string') throw new Error('prompt required (string)')
  if (!scheduleCore.isValid(p.schedule)) {
    throw new Error('invalid schedule: "' + p.schedule + '" (use "every Xm|h", "daily HH:MM", "weekly <mon-sun> HH:MM", or a raw cron expression)')
  }
  const tz = p.tz || 'Australia/Brisbane'
  const priorityClass = normalisePriorityClass(p.priority_class)
  const priority = priorityForClass(priorityClass)

  // Store the schedule AS GIVEN. The shared engine reads aliases and raw cron
  // alike; intervals ("every 72h") cannot be expressed as cron so must not be
  // normalised. Compute the first next_run_at via the same engine the rearm uses.
  const cronExpr = String(p.schedule).trim()
  const firstRun = scheduleCore.nextRun(p.schedule, new Date(), tz)
  if (!firstRun) throw new Error('invalid schedule (could not compute next run): "' + p.schedule + '"')

  const pool = getPool()
  const sql = `
    INSERT INTO os_scheduled_tasks
      (type, name, prompt, cron_expression, next_run_at, preferred_account, priority, tz, status)
    VALUES ('cron', $1, $2, $3, $4, $5, $6, $7, 'active')
    RETURNING id, cron_expression, next_run_at, tz
  `
  const result = await pool.query(sql, [
    p.name,
    p.prompt,
    cronExpr,
    firstRun.toISOString(),
    p.preferred_account || null,
    priority,
    tz,
  ])
  const row = result.rows[0]
  return {
    ok: true,
    id: row.id,
    type: 'cron',
    schedule_expression: row.cron_expression,
    tz: row.tz,
    priority_class: priorityClass,
    next_fire_at_utc: new Date(row.next_run_at).toISOString(),
    next_fire_at_aest: toAestIso(row.next_run_at),
  }
}

const ACTIVE_STATUSES = new Set(['active', 'dispatching', 'running'])
const ARCHIVED_STATUSES = new Set(['completed', 'failed', 'orphaned'])

exports.schedule_list = async function schedule_list(params) {
  const p = params || {}
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || 100, 1), 100)
  const archived = p.archived === true

  const clauses = []
  const vals = []
  if (archived) {
    vals.push(Array.from(ARCHIVED_STATUSES))
    clauses.push('status = ANY($' + vals.length + ')')
  } else {
    vals.push(Array.from(ACTIVE_STATUSES))
    clauses.push('status = ANY($' + vals.length + ')')
  }
  if (p.type) {
    vals.push(p.type)
    clauses.push('type = $' + vals.length)
  }
  if (p.name_like) {
    vals.push('%' + p.name_like + '%')
    clauses.push('name ILIKE $' + vals.length)
  }
  vals.push(limit)

  const sql = `
    SELECT id, type, name, prompt, cron_expression, run_at, next_run_at, last_run_at,
           status, run_count, priority, preferred_account, actual_account, tz,
           last_error, last_result, created_at, updated_at
    FROM os_scheduled_tasks
    WHERE ${clauses.join(' AND ')}
    ORDER BY next_run_at ASC NULLS LAST, created_at DESC
    LIMIT $${vals.length}
  `
  const pool = getPool()
  const result = await pool.query(sql, vals)
  const rows = result.rows.map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    prompt: (r.prompt || '').slice(0, 200),
    cron_expression: r.cron_expression,
    run_at_utc: r.run_at ? new Date(r.run_at).toISOString() : null,
    run_at_aest: toAestIso(r.run_at),
    next_run_at_utc: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
    next_run_at_aest: toAestIso(r.next_run_at),
    last_run_at_utc: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
    status: r.status,
    run_count: r.run_count,
    priority: r.priority,
    preferred_account: r.preferred_account,
    actual_account: r.actual_account,
    tz: r.tz,
    last_error: r.last_error,
    last_result: r.last_result ? r.last_result.slice(0, 200) : null,
  }))
  return { ok: true, count: rows.length, limit, archived, rows }
}

// ── A2 CRUD: cancel / pause / resume / run_now / chain ──────────────────────

// Resolve a row by id (uuid) or name. Returns the row or null.
async function _resolveRow(p) {
  const pool = getPool()
  if (p.id) {
    const r = await pool.query(`SELECT * FROM os_scheduled_tasks WHERE id = $1`, [p.id])
    return r.rows[0] || null
  }
  if (p.name) {
    // Prefer active, fall back to most-recent if multiple matches exist.
    const r = await pool.query(
      `SELECT * FROM os_scheduled_tasks
       WHERE name = $1
       ORDER BY (archived_at IS NULL) DESC, created_at DESC
       LIMIT 1`,
      [p.name]
    )
    return r.rows[0] || null
  }
  throw new Error('id or name required')
}

exports.schedule_cancel = async function schedule_cancel(params) {
  const p = params || {}
  const row = await _resolveRow(p)
  if (!row) return { ok: false, error: 'task not found', id: p.id || null, name: p.name || null }
  const pool = getPool()
  const result = await pool.query(
    // 2026-06-19 cancellation-durability fix: also set status='cancelled', not
    // just last_status + archived_at. Pre-fix, a cancelled cron kept whatever
    // status it had (often 'active'), and any re-arm UPDATE that matched BY ID
    // without an archived_at/last_status guard would resurrect it. The guard is
    // now applied at every status='active' re-arm site (markFailed, markComplete,
    // staleLeaseRecovery), and status itself is made terminal here so the row is
    // internally consistent (status agrees with last_status/archived_at).
    `UPDATE os_scheduled_tasks
     SET status = 'cancelled', archived_at = NOW(), last_status = 'cancelled', updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, archived_at`,
    [row.id]
  )
  const r = result.rows[0]
  return {
    ok: true,
    id: r.id,
    name: r.name,
    cancelled_at_utc: new Date(r.archived_at).toISOString(),
    cancelled_at_aest: toAestIso(r.archived_at),
  }
}

exports.schedule_pause = async function schedule_pause(params) {
  const p = params || {}
  const row = await _resolveRow(p)
  if (!row) return { ok: false, error: 'task not found', id: p.id || null, name: p.name || null }
  if (row.archived_at) {
    return { ok: false, error: 'task is cancelled (archived); cannot pause', id: row.id, name: row.name }
  }
  const pool = getPool()
  const result = await pool.query(
    `UPDATE os_scheduled_tasks
     SET last_status = 'paused', updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, updated_at`,
    [row.id]
  )
  const r = result.rows[0]
  return {
    ok: true,
    id: r.id,
    name: r.name,
    paused_at_utc: new Date(r.updated_at).toISOString(),
    paused_at_aest: toAestIso(r.updated_at),
  }
}

exports.schedule_resume = async function schedule_resume(params) {
  const p = params || {}
  const row = await _resolveRow(p)
  if (!row) return { ok: false, error: 'task not found', id: p.id || null, name: p.name || null }
  if (row.archived_at) {
    return { ok: false, error: 'task is cancelled (archived); cannot resume', id: row.id, name: row.name }
  }
  if (row.last_status !== 'paused') {
    return { ok: false, error: 'task is not paused (last_status=' + (row.last_status || 'null') + ')', id: row.id, name: row.name }
  }

  // Recompute next_run_at:
  //  - cron rows: next interval from now using row.tz
  //  - delayed rows: NOW() (the original delay window has passed during pause)
  //  - other types: NOW()
  let nextRunAt = new Date()
  if (row.type === 'cron' && row.cron_expression) {
    try {
      nextRunAt = new Date(exports.computeNextRunAt(row))
    } catch (cronErr) {
      process.stderr.write('[scheduler] schedule_resume cron-parse error for "' + row.cron_expression + '": ' + cronErr.message + '\n')
    }
  }

  const pool = getPool()
  const result = await pool.query(
    `UPDATE os_scheduled_tasks
     SET last_status = NULL, next_run_at = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, next_run_at, updated_at`,
    [row.id, nextRunAt.toISOString()]
  )
  const r = result.rows[0]
  return {
    ok: true,
    id: r.id,
    name: r.name,
    resumed_at_utc: new Date(r.updated_at).toISOString(),
    resumed_at_aest: toAestIso(r.updated_at),
    next_fire_at_utc: new Date(r.next_run_at).toISOString(),
    next_fire_at_aest: toAestIso(r.next_run_at),
  }
}

exports.schedule_run_now = async function schedule_run_now(params) {
  const p = params || {}
  const row = await _resolveRow(p)
  if (!row) return { ok: false, error: 'task not found', id: p.id || null, name: p.name || null }
  if (row.archived_at) {
    return { ok: false, error: 'task is cancelled (archived); cannot run', id: row.id, name: row.name }
  }
  if (row.last_status === 'paused') {
    return { ok: false, error: 'task is paused; resume first', id: row.id, name: row.name }
  }
  const pool = getPool()
  const result = await pool.query(
    `UPDATE os_scheduled_tasks
     SET next_run_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, next_run_at`,
    [row.id]
  )
  const r = result.rows[0]
  return {
    ok: true,
    id: r.id,
    name: r.name,
    next_fire_at_utc: new Date(r.next_run_at).toISOString(),
    next_fire_at_aest: toAestIso(r.next_run_at),
  }
}

exports.schedule_chain = async function schedule_chain(params) {
  const p = params || {}
  if (!p.after_task_id || typeof p.after_task_id !== 'string') {
    throw new Error('after_task_id required (string uuid)')
  }
  if (!p.name || typeof p.name !== 'string') throw new Error('name required (string)')
  if (!p.prompt || typeof p.prompt !== 'string') throw new Error('prompt required (string)')

  const pool = getPool()
  // Verify parent exists - chain target must be resolvable.
  const parent = await pool.query(
    `SELECT id, name, status, archived_at FROM os_scheduled_tasks WHERE id = $1`,
    [p.after_task_id]
  )
  if (!parent.rows.length) {
    return { ok: false, error: 'after_task_id not found', after_task_id: p.after_task_id }
  }

  const priorityClass = normalisePriorityClass(p.priority_class)
  const priority = priorityForClass(priorityClass)

  // Chain rows insert with status='active', next_run_at=NULL. markComplete on
  // the parent wakes them via the chain wake-up hook (sets next_run_at=NOW()).
  // type='chained' is one of the allowed values in os_scheduled_tasks_type_check
  // (cron|delayed|chained). leaseDueRows skips parked chain rows by requiring
  // next_run_at IS NOT NULL when chain_after is set.
  const sql = `
    INSERT INTO os_scheduled_tasks
      (type, name, prompt, chain_after, next_run_at, preferred_account, priority, status)
    VALUES ('chained', $1, $2, $3, NULL, $4, $5, 'active')
    RETURNING id, name, chain_after, status, created_at
  `
  const result = await pool.query(sql, [
    p.name,
    p.prompt,
    p.after_task_id,
    p.preferred_account || null,
    priority,
  ])
  const r = result.rows[0]
  return {
    ok: true,
    id: r.id,
    name: r.name,
    type: 'chain',
    chain_after: r.chain_after,
    parent_name: parent.rows[0].name,
    parent_status: parent.rows[0].status,
    priority_class: priorityClass,
    created_at_utc: new Date(r.created_at).toISOString(),
    created_at_aest: toAestIso(r.created_at),
  }
}

// Internals exposed for inline unit testing.
exports._parseDelay = parseDelay
exports._parseSchedule = parseSchedule
exports._normalisePriorityClass = normalisePriorityClass
exports._priorityForClass = priorityForClass
exports._toAestIso = toAestIso
exports._resolveRow = _resolveRow

// ── reapOrphanWorktrees ──────────────────────────────────────────────────────
//
// 2026-06-20 autonomy audit finding (b). Standing GC for leaked dispatched-worker
// worktrees. pruneWorktreeForRow only fires on a row's OWN completion / failure /
// recovery, so a crashed worker or a dispatcher restart mid-dispatch leaks its
// dir forever (5.0 GB / 70 dirs observed 2026-06-20). This sweeps WORKTREE_ROOT
// on boot and removes ONLY dirs that provably cannot lose work and are not live:
//   - the row is not running and not freshly leased (< REAP_LIVE_GRACE_MS), AND
//   - it is a REGISTERED worktree whose worker/<id> branch is fully merged into
//     origin/main AND whose working tree is clean (git status --porcelain empty).
// Unregistered leftover dirs and any dir with unpushed commits / uncommitted
// changes / a live lease are PRESERVED (worktree work must be pushed before
// removal, never orphaned). Best-effort and fully tolerant; returns a tally.
const REAP_LIVE_GRACE_MS = 30 * 60 * 1000
exports.reapOrphanWorktrees = async function reapOrphanWorktrees(opts) {
  const dryRun = !!(opts && opts.dryRun)
  const tally = { scanned: 0, reaped: 0, preserved: 0, skippedLive: 0, reapedIds: [] }
  let entries = []
  try {
    entries = fs.readdirSync(WORKTREE_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name)
  } catch (_e) { return tally }
  tally.scanned = entries.length
  if (!entries.length) return tally

  // Coord live-worker set, fetched ONCE. FAIL SAFE: if coord is unreachable we
  // cannot tell which worktrees belong to running workers, so we reap NOTHING
  // this pass (the opposite of hasLiveWorkerForTask's fail-open - here a missed
  // live worker means destroying its tree, which is worse than skipping a GC).
  // 2026-06-20: the DB status/lease check ALONE missed the live coord worker
  // 3222c393 (its os_scheduled_tasks row was not running/fresh-leased but its
  // heartbeat was alive); the dry-run caught it before any deletion.
  const liveIds = new Set()
  try {
    const r = await getCoord().list_workers({})
    for (const w of ((r && r.workers) || [])) {
      if (w.terminated_at || w.dead) continue
      if (typeof w.stale_ms === 'number' && w.stale_ms >= STALE_WORKER_LIVENESS_MS) continue
      if (w.task_id) liveIds.add(String(w.task_id))
    }
  } catch (e) {
    process.stderr.write('[scheduler] reapOrphanWorktrees: coord unavailable, reaping nothing (fail-safe): ' + (e && e.message) + '\n')
    return tally
  }

  await runGit(['fetch', 'origin', 'main', '--quiet']).catch(() => {})
  const registered = new Set()
  try {
    const out = await runGit(['worktree', 'list', '--porcelain'])
    for (const line of String((out && out.stdout) || out || '').split('\n')) {
      if (line.startsWith('worktree ')) registered.add(line.slice('worktree '.length).trim())
    }
  } catch (_e) {}

  const pool = getPool()
  for (const id of entries) {
    const wtPath = path.join(WORKTREE_ROOT, id)
    if (!wtPath.startsWith(WORKTREE_ROOT + path.sep)) continue // safety bound

    // Liveness gate 1: a live coord worker (fresh heartbeat) owns this dir.
    if (liveIds.has(id)) { tally.skippedLive++; continue }

    // Liveness gate 2: running row or fresh lease -> never touch.
    let live = false
    try {
      const r = await pool.query(
        `SELECT status, leased_at FROM os_scheduled_tasks WHERE id = $1`, [id])
      const row = r.rows[0]
      if (row) {
        if (row.status === 'running') live = true
        if (row.leased_at && (Date.now() - new Date(row.leased_at).getTime()) < REAP_LIVE_GRACE_MS) live = true
      }
    } catch (_e) { live = true } // fail safe: cannot confirm dead -> keep
    if (live) { tally.skippedLive++; continue }

    // Safe-to-drop: registered + branch merged + working tree clean. Anything
    // else (unregistered leftover, unpushed branch, dirty tree) is preserved.
    if (!registered.has(wtPath)) { tally.preserved++; continue }
    const merged = await runGit(['merge-base', '--is-ancestor', 'worker/' + id, 'origin/main'])
      .then(() => true).catch(() => false)
    if (!merged) { tally.preserved++; continue }
    let clean = false
    try {
      const st = await execFileP('git', ['-C', wtPath, 'status', '--porcelain'], { timeout: WORKTREE_GIT_TIMEOUT_MS })
      clean = !String((st && st.stdout) || '').trim()
    } catch (_e) { clean = false }
    if (!clean) { tally.preserved++; continue }

    if (dryRun) { tally.reaped++; tally.reapedIds.push(id); continue }
    await runGit(['worktree', 'remove', '--force', wtPath]).catch(() => {})
    await runGit(['worktree', 'prune']).catch(() => {})
    if (fs.existsSync(wtPath)) {
      try { fs.rmSync(wtPath, { recursive: true, force: true }) } catch (_e) {}
      await runGit(['worktree', 'prune']).catch(() => {})
    }
    await runGit(['branch', '-D', 'worker/' + id]).catch(() => {})
    tally.reaped++; tally.reapedIds.push(id)
  }
  return tally
}

// ── wake-stall detection (sleep-resilience) ──────────────────────────────────
//
// Pure + deterministic so the wake path is unit-testable with an injected clock
// instead of fake timers. Returns whether the Node event loop was frozen between
// two consecutive stale-lease ticks (the host slept). `frozenMs` is the observed
// inter-tick gap; `stalled` is true when that gap exceeds intervalMs * factor.
// Doctrine: [[scheduler-must-survive-mac-sleep-2026-06-20]].
exports.detectWakeStall = function detectWakeStall(prevTickMs, nowMs, intervalMs, factor) {
  const f = (typeof factor === 'number' && factor > 1) ? factor : WAKE_STALL_FACTOR
  const frozenMs = nowMs - prevTickMs
  return { stalled: frozenMs > intervalMs * f, frozenMs }
}

// Surface a wake-stall to the conductor / Tate via observer_signals so a silent
// nightly sleep-stall becomes a visible signal on the next CC turn (mirrors the
// usage-cap observer). Best-effort, app-level dedup to one signal per host-hour so
// a single multi-hour freeze does not spam. Doctrine:
// [[health-canary-must-alert-not-silently-accumulate]].
const _wakeStallLast = { hourKey: null }
exports._resetWakeStallLast = function () { _wakeStallLast.hourKey = null }
exports.recordWakeStall = async function recordWakeStall(frozenMs) {
  const mins = Math.round(frozenMs / 60000)
  const hourKey = new Date().toISOString().slice(0, 13)   // dedup per host-hour
  if (_wakeStallLast.hourKey === hourKey) return { skipped: 'cooldown', minutes: mins }
  await getPool().query(
    `INSERT INTO observer_signals (observer_name, signal_kind, message, fingerprint, priority, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    ['scheduler-wake-stall-observer', 'scheduler_wake_stall',
     'Scheduler event loop was frozen ~' + mins + ' min (host sleep/hibernate). Crons leased before the freeze may have stalled in running/dispatching; staleLeaseRecovery ran a catch-up sweep on wake. If this recurs nightly, keep the Mac on AC power or wrap the laptop-agent in `caffeinate -s` (note: critical-battery hibernate ignores caffeinate).',
     'scheduler_wake_stall:' + hourKey, 2]
  )
  _wakeStallLast.hourKey = hourKey
  return { fired: true, minutes: mins }
}

// One stale-lease tick: detect a wake-from-sleep gap, surface it + run an
// immediate catch-up recovery, then run the normal recovery sweep. Extracted from
// the setInterval callback so the wake path is testable with an injected clock.
// `_lastStaleTickMs` is module state seeded by start(); pass nowMs explicitly so
// tests stay deterministic.
let _lastStaleTickMs = null
exports._resetStaleTickClock = function (ms) { _lastStaleTickMs = (typeof ms === 'number') ? ms : null }
exports.staleTick = async function staleTick(nowMs) {
  const now = (typeof nowMs === 'number') ? nowMs : Date.now()
  if (_lastStaleTickMs !== null) {
    const wake = exports.detectWakeStall(_lastStaleTickMs, now, STALE_LEASE_INTERVAL_MS)
    if (wake.stalled) {
      exports._wakeStallCount = (exports._wakeStallCount || 0) + 1
      process.stderr.write(
        '[scheduler] WAKE-STALL: event loop frozen ~' + Math.round(wake.frozenMs / 1000) +
        's (likely host sleep/hibernate) - running immediate catch-up staleLeaseRecovery\n'
      )
      try { await exports.recordWakeStall(wake.frozenMs) } catch (e) {
        process.stderr.write('[scheduler] recordWakeStall error: ' + e.message + '\n')
      }
    }
  }
  _lastStaleTickMs = now
  await exports.staleLeaseRecovery()
}
exports._wakeStallCount = 0

// ── start ────────────────────────────────────────────────────────────────────
//
// Starts all three intervals plus the usage-cap observer. Wraps each in
// try/catch so one bad pass does not tank the entire loop.

exports.start = function start() {
  process.stderr.write('[scheduler] starting dispatch loop + completion poller + stale-lease recovery + cap observer\n')

  // Non-blocking startup cleanup.
  exports.startupCleanup().catch(e => {
    process.stderr.write('[scheduler] startupCleanup error: ' + e.message + '\n')
  })

  // Non-blocking orphan-worktree GC (2026-06-20 audit finding b). Conservative:
  // only reaps registered worktrees whose branch is merged + tree is clean + not
  // live; preserves everything else. Boot cadence (restarts are the natural GC
  // point); idempotent.
  exports.reapOrphanWorktrees().then(t => {
    process.stderr.write('[scheduler] reapOrphanWorktrees: scanned=' + t.scanned +
      ' reaped=' + t.reaped + ' preserved=' + t.preserved + ' skippedLive=' + t.skippedLive + '\n')
  }).catch(e => {
    process.stderr.write('[scheduler] reapOrphanWorktrees error: ' + e.message + '\n')
  })
  // 2026-06-20 sleep-resilience: reconcile stuck dispatching/running leases
  // IMMEDIATELY on start (boot / KeepAlive restart / first runtime after a host
  // sleep), not only on the first 60s stale-lease tick. startupCleanup above only
  // closes leaked tabs - it does NOT recover leases. Seeds the wake-stall clock so
  // the first scheduled tick measures the gap from now.
  exports._resetStaleTickClock(Date.now())
  exports.staleLeaseRecovery().catch(e => {
    process.stderr.write('[scheduler] startup staleLeaseRecovery error: ' + e.message + '\n')
  })

  // Dispatch loop.
  const dispatchInterval = setInterval(async () => {
    try {
      let rows = []
      try {
        rows = await exports.leaseDueRows(DISPATCH_LIMIT)
      } catch (e) {
        process.stderr.write('[scheduler] leaseDueRows error: ' + e.message + '\n')
        return
      }
      for (const row of rows) {
        try {
          await exports.dispatchOne(row)
        } catch (e) {
          // dispatchOne already called markFailed; just log.
          process.stderr.write('[scheduler] dispatchOne error for ' + row.id + ': ' + e.message + '\n')
        }
      }
    } catch (e) {
      process.stderr.write('[scheduler] dispatch loop error: ' + e.message + '\n')
    }
  }, POLL_INTERVAL_MS)

  // Completion pass.
  const completionInterval = setInterval(async () => {
    try {
      await exports.completionPass()
    } catch (e) {
      process.stderr.write('[scheduler] completionPass error: ' + e.message + '\n')
    }
  }, COMPLETION_POLL_INTERVAL_MS)

  // Stale-lease recovery. Routed through staleTick so a wake-from-sleep gap is
  // detected, surfaced (observer_signals), and followed by an immediate catch-up
  // recovery on the first resumed tick. Doctrine:
  // [[scheduler-must-survive-mac-sleep-2026-06-20]].
  const staleInterval = setInterval(async () => {
    try {
      await exports.staleTick(Date.now())
    } catch (e) {
      process.stderr.write('[scheduler] staleLeaseRecovery error: ' + e.message + '\n')
    }
  }, STALE_LEASE_INTERVAL_MS)

  // Usage-cap observer.
  const capObserverInterval = setInterval(async () => {
    try {
      await exports.checkCapWarning()
    } catch (e) {
      process.stderr.write('[scheduler] checkCapWarning error: ' + e.message + '\n')
    }
  }, CAP_OBSERVER_INTERVAL_MS)

  // 2026-05-29 ultracode audit C3 fix. cleanup_orphan_workers reconciles
  // the worker registry against live ide.tabs and closes orphans the strict
  // close path could not match. The audit caught this wired to zero cron -
  // the entire 'better leak than wrong-close' posture assumed this ran on a
  // schedule. Now does, every CLEANUP_ORPHAN_INTERVAL_MS.
  const cleanupOrphanInterval = setInterval(async () => {
    try {
      const dispatcher = getDispatcher()
      if (dispatcher.cleanup_orphan_workers) {
        const r = await dispatcher.cleanup_orphan_workers({ max_age_days: 7, force_untitled: false })
        if (r && (r.closed > 0 || r.candidates > 0)) {
          process.stderr.write('[scheduler] cleanup_orphan_workers: closed=' + r.closed + ' of ' + r.candidates + ' candidates (leaked=' + (r.leaked || 0) + ')\n')
        }
      }
    } catch (e) {
      process.stderr.write('[scheduler] cleanup_orphan_workers error: ' + e.message + '\n')
    }
  }, CLEANUP_ORPHAN_INTERVAL_MS)

  // Unref so the intervals don't prevent process exit in test environments.
  if (dispatchInterval.unref) dispatchInterval.unref()
  if (completionInterval.unref) completionInterval.unref()
  if (staleInterval.unref) staleInterval.unref()
  if (capObserverInterval.unref) capObserverInterval.unref()
  if (cleanupOrphanInterval.unref) cleanupOrphanInterval.unref()

  return { dispatchInterval, completionInterval, staleInterval, capObserverInterval, cleanupOrphanInterval }
}
