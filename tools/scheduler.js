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
const cronParser = require('cron-parser')
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
// 2026-05-29 ultracode audit C3 fix. cleanup_orphan_workers is the only
// backstop the chain's refuse-and-leak posture relies on; the audit caught
// it wired to no cron at all. 7 min picks up leaked tabs within a worker
// lifetime, doesn't thrash ide.tabs.
const CLEANUP_ORPHAN_INTERVAL_MS = 7 * 60 * 1000

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
        AND austerity_paused IS NOT TRUE
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
  return result.rows
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
        const tz = row.tz || 'Australia/Brisbane'
        // 2026-06-03: translate friendly aliases ("every 4h", "daily 20:00")
        // via parseSchedule before handing to cron-parser. Rows inserted
        // before the parseSchedule INSERT-side translation landed (or via
        // direct SQL) store the raw alias; cron-parser cannot parse those
        // and silently leaves nextRunAt=null.
        const cronExpr = parseSchedule(row.cron_expression)
        const interval = cronParser.CronExpressionParser.parse(cronExpr, { tz })
        nextRunAt = interval.next().toDate().toISOString()
      } catch (_e) {
        nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'active', retry_count = 0, last_error = $1, next_run_at = $2,
             leased_by = NULL, leased_at = NULL, updated_at = NOW()
         WHERE id = $3`,
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
       WHERE id = $3`,
      [newRetryCount, errMsg, row.id]
    )
  }
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

    // 1. Pick + rotate to healthiest account.
    const picked = await getCreds().pick_healthiest_account({
      preferred: row.preferred_account || null,
      required_headroom_minutes: 15,
    })
    const rotateResult = await getCreds().rotate_to(picked)
    // 2026-06-08 (safety gate): rotate_to returns {deferred:true} on Mac when
    // other workers are active (Keychain is a shared resource - rotating
    // while other-account workers are mid-flight would 401 them on next refresh).
    // When deferred, dispatch on whatever account is currently authenticated;
    // the next cron fire will retry rotation when the registry is idle.
    if (rotateResult && rotateResult.deferred) {
      const liveAccount = getCreds().current_account()
      process.stderr.write('[scheduler] dispatchOne: rotation to ' + picked +
        ' deferred (active_workers=' + rotateResult.active_count + '), dispatching on ' +
        liveAccount + ' instead\n')
      account = liveAccount
    } else {
      account = picked
    }

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
    } else if (errMsg.includes('no IDE instances registered')) {
      // 2026-06-02 P0 fix. The dispatch_worker editor.open path throws this when
      // no VS Code / Cursor / Insiders instance has registered the ecodia-preview
      // extension with the laptop-agent bridge. This is TRANSIENT (Tate closes
      // the IDE, machine reboots, extension reloads). Treat it the same way as
      // AllAccountsCappedError: defer ~5min, do NOT increment retry_count, do
      // NOT mark failed. The cron survives the gap window naturally.
      const deferMs = 5 * 60 * 1000
      const nextRun = new Date(Date.now() + deferMs)
      try {
        await pool.query(
          `UPDATE os_scheduled_tasks
           SET status = 'active', leased_by = NULL, leased_at = NULL,
               next_run_at = $1, last_error = $2, updated_at = NOW()
           WHERE id = $3`,
          [nextRun.toISOString(), 'no IDE bridge registered - deferred 5min', row.id]
        )
      } catch (pgErr) {
        process.stderr.write('[scheduler] no-IDE defer pg error: ' + pgErr.message + '\n')
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
      const tz = row.tz || 'Australia/Brisbane'
      // 2026-06-03: friendly-alias translation (see markFailed for rationale).
      const cronExpr = parseSchedule(row.cron_expression)
      const interval = cronParser.CronExpressionParser.parse(cronExpr, { tz })
      nextRunAt = interval.next().toDate().toISOString()
    } catch (cronErr) {
      process.stderr.write('[scheduler] cron-parser error for "' + row.cron_expression + '": ' + cronErr.message + '\n')
    }
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', last_run_at = NOW(), next_run_at = $1,
           run_count = run_count + 1, last_result = $2,
           retry_count = 0, leased_by = NULL, leased_at = NULL,
           ${dispatchedTabIdSqlFrag} updated_at = NOW()
       WHERE id = $3`,
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
    if (row.leased_at) {
      const doneMs = new Date(msg.created_at).getTime()
      const leasedMs = new Date(row.leased_at).getTime()
      if (!isNaN(doneMs) && !isNaN(leasedMs) && doneMs < leasedMs - 30_000) continue
    }
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

  // 1. Stale dispatching, retryable.
  await pool.query(
    `UPDATE os_scheduled_tasks
     SET status = 'active', retry_count = retry_count + 1,
         last_error = 'stale lease recovered',
         leased_by = NULL, leased_at = NULL, updated_at = NOW()
     WHERE status = 'dispatching'
       AND leased_at < NOW() - ($1 || ' milliseconds')::interval
       AND retry_count < $2`,
    [STALE_DISPATCHING_MS, MAX_RETRY_COUNT]
  )

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
      const tz = row.tz || 'Australia/Brisbane'
      const cronExpr = parseSchedule(row.cron_expression)
      const interval = cronParser.CronExpressionParser.parse(cronExpr, { tz })
      nextRunAt = interval.next().toDate().toISOString()
    } catch (_e) {
      nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', retry_count = 0,
           last_error = 'stale lease - max retries exhausted (cron: deferred to next interval per doctrine)',
           next_run_at = $1, leased_by = NULL, leased_at = NULL, updated_at = NOW()
       WHERE id = $2`,
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
  const orphans = await pool.query(
    `SELECT id, dispatched_tab_id, type, cron_expression, tz FROM os_scheduled_tasks
     WHERE status = 'running'
       AND leased_at < NOW() - ($1 || ' milliseconds')::interval`,
    [ORPHAN_TIMEOUT_MS]
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
        const tz = row.tz || 'Australia/Brisbane'
        const cronExpr = parseSchedule(row.cron_expression)
        const interval = cronParser.CronExpressionParser.parse(cronExpr, { tz })
        nextRunAt = interval.next().toDate().toISOString()
      } catch (_e) {
        nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
      await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'active', retry_count = 0, last_run_at = NOW(),
             next_run_at = $1,
             last_error = 'running orphan-timeout (cron: deferred to next interval per doctrine)',
             leased_by = NULL, leased_at = NULL, ${tabFrag} updated_at = NOW()
         WHERE id = $2`,
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
function parseSchedule(schedule) {
  if (!schedule || typeof schedule !== 'string') {
    throw new Error('schedule required (string)')
  }
  const s = schedule.trim()
  const every = s.match(/^every\s+(\d+)\s*([mh])\s*$/i)
  if (every) {
    const n = parseInt(every[1], 10)
    const unit = every[2].toLowerCase()
    if (unit === 'h') return `0 */${n} * * *`
    return `*/${n} * * * *`
  }
  const daily = s.match(/^daily\s+(\d{1,2}):(\d{2})\s*$/i)
  if (daily) {
    return `${parseInt(daily[2], 10)} ${parseInt(daily[1], 10)} * * *`
  }
  // Assume already cron. Validate via cron-parser at the call site.
  return s
}

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
  const cronExpr = parseSchedule(p.schedule)
  const tz = p.tz || 'Australia/Brisbane'
  const priorityClass = normalisePriorityClass(p.priority_class)
  const priority = priorityForClass(priorityClass)

  // Compute first next_run_at via cron-parser with the row's tz.
  let firstRun
  try {
    const interval = cronParser.CronExpressionParser.parse(cronExpr, { tz, currentDate: new Date() })
    firstRun = interval.next().toDate()
  } catch (e) {
    throw new Error('invalid cron expression "' + cronExpr + '": ' + e.message)
  }

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
    `UPDATE os_scheduled_tasks
     SET archived_at = NOW(), last_status = 'cancelled', updated_at = NOW()
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
      const tz = row.tz || 'Australia/Brisbane'
      // 2026-06-03: friendly-alias translation (see markFailed for rationale).
      const cronExpr = parseSchedule(row.cron_expression)
      const interval = cronParser.CronExpressionParser.parse(cronExpr, { tz, currentDate: new Date() })
      nextRunAt = interval.next().toDate()
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

  // Stale-lease recovery.
  const staleInterval = setInterval(async () => {
    try {
      await exports.staleLeaseRecovery()
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
