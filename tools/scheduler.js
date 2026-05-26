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
const cronParser = require('cron-parser')
const creds = require('./creds')
const coord = require('./coord')

// ── constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000
const STALE_LEASE_INTERVAL_MS = 60_000
const DISPATCH_LIMIT = 5
const SIGNAL_BOUND_TIMEOUT_MS = 30_000
const ORPHAN_TIMEOUT_MS = 6 * 60 * 60 * 1000
const COMPLETION_POLL_INTERVAL_MS = 5_000
const STALE_DISPATCHING_MS = 10 * 60 * 1000   // 10 min -> retry
const MAX_RETRY_COUNT = 3

// ── Postgres pool (injection seam for tests) ─────────────────────────────────

let _pool = null

function getPool() {
  if (!_pool) {
    const connStr = process.env.DATABASE_URL
    if (!connStr) throw new Error('scheduler: DATABASE_URL env var is required')
    _pool = new Pool({ connectionString: connStr })
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

  const lines = [
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
  ]

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
  const sql = `
    WITH due AS (
      SELECT id FROM os_scheduled_tasks
      WHERE status = 'active'
        AND (next_run_at IS NULL OR next_run_at <= NOW())
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
  if (newRetryCount >= MAX_RETRY_COUNT) {
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'failed', retry_count = $1, last_error = $2,
           leased_by = NULL, leased_at = NULL, updated_at = NOW()
       WHERE id = $3`,
      [newRetryCount, String(err && err.message || err).slice(0, 2000), row.id]
    )
  } else {
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', retry_count = $1, last_error = $2,
           leased_by = NULL, leased_at = NULL, updated_at = NOW()
       WHERE id = $3`,
      [newRetryCount, String(err && err.message || err).slice(0, 2000), row.id]
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
    // 1. Pick + rotate to healthiest account.
    account = await creds.pick_healthiest_account({
      preferred: row.preferred_account || null,
      required_headroom_minutes: 15,
    })
    await creds.rotate_to(account)

    // 2. Build brief with actual_account filled in.
    const rowWithAccount = Object.assign({}, row, { actual_account: account })
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
            // Mark the message seen so it doesn't linger.
            try { await coord.read_inbox({ topic: 'chat.conductor.inbox', limit: 1 }) } catch (e) {}
            break
          }
        }
      }
      if (bound) break
      await new Promise(r => setTimeout(r, 1000))
    }

    // 5. Update row to running.
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'running', actual_account = $1, dispatched_tab_id = $2,
           leased_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [account, tabId, row.id]
    )

    if (!bound) {
      process.stderr.write('[scheduler] dispatchOne: signal_bound timeout for task ' + row.id + ' (tab ' + tabId + ')\n')
    }
  } catch (err) {
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

  // Try to close the tab (v1: noop - kill_worker is focus-dependent).
  if (row.dispatched_tab_id) {
    try {
      if (dispatcher.kill_worker) {
        await dispatcher.kill_worker({ tab_id: row.dispatched_tab_id })
      }
    } catch (e) {
      process.stderr.write('[scheduler] close_tab tolerated error: ' + e.message + '\n')
    }
  }

  const isSuccess = signal && signal.status === 'success'

  if (!isSuccess) {
    // Treat as failure: delegate to markFailed with a synthetic error.
    const syntheticErr = new Error(
      (signal && signal.result_summary) || 'task signaled non-success'
    )
    syntheticErr.message = (signal && signal.result_summary) || 'task signaled non-success'
    return exports.markFailed(row, syntheticErr)
  }

  const rowType = row.type || 'one_shot'

  if (rowType === 'cron' && row.cron_expression) {
    // Compute next_run_at via cron-parser.
    let nextRunAt = null
    try {
      const interval = cronParser.CronExpressionParser.parse(row.cron_expression, { utc: true })
      nextRunAt = interval.next().toDate().toISOString()
    } catch (cronErr) {
      process.stderr.write('[scheduler] cron-parser error for "' + row.cron_expression + '": ' + cronErr.message + '\n')
    }
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'active', last_run_at = NOW(), next_run_at = $1,
           run_count = run_count + 1, last_result = $2,
           retry_count = 0, leased_by = NULL, leased_at = NULL,
           dispatched_tab_id = NULL, updated_at = NOW()
       WHERE id = $3`,
      [nextRunAt, String((signal && signal.result_summary) || '').slice(0, 2000), row.id]
    )
  } else {
    // one_shot or delayed: mark completed.
    await pool.query(
      `UPDATE os_scheduled_tasks
       SET status = 'completed', last_run_at = NOW(), last_result = $1,
           run_count = run_count + 1, leased_by = NULL, leased_at = NULL,
           dispatched_tab_id = NULL, updated_at = NOW()
       WHERE id = $2`,
      [String((signal && signal.result_summary) || '').slice(0, 2000), row.id]
    )
  }
}

// ── completionPass ───────────────────────────────────────────────────────────
//
// Checks coord inbox for done signals from running tasks and completes them.
// Non-destructive: uses peek_inbox to scan, then targeted read_inbox to consume.

exports.completionPass = async function completionPass() {
  const pool = getPool()

  // Fetch all running rows.
  const result = await pool.query(
    `SELECT * FROM os_scheduled_tasks WHERE status = 'running' LIMIT 50`
  )
  if (!result.rows.length) return

  // Peek at conductor inbox for done signals.
  const inbox = await coord.peek_inbox({ topic: 'chat.conductor.inbox', limit: 100 })
  if (!inbox || !inbox.messages || !inbox.messages.length) return

  // Build a map: task_id -> signal
  const doneSignals = new Map()
  for (const msg of inbox.messages) {
    const body = msg.body
    if (body && body.type === 'done' && body.task_id) {
      // keep first (oldest) signal per task
      if (!doneSignals.has(String(body.task_id))) {
        doneSignals.set(String(body.task_id), body)
      }
    }
  }

  if (!doneSignals.size) return

  for (const row of result.rows) {
    const taskIdStr = String(row.id)
    const signal = doneSignals.get(taskIdStr)
    if (!signal) continue
    try {
      await exports.markComplete(row, signal)
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

  // 2. Stale dispatching, max retries exhausted.
  await pool.query(
    `UPDATE os_scheduled_tasks
     SET status = 'failed', retry_count = retry_count + 1,
         last_error = 'stale lease - max retries exhausted',
         leased_by = NULL, leased_at = NULL, updated_at = NOW()
     WHERE status = 'dispatching'
       AND leased_at < NOW() - ($1 || ' milliseconds')::interval
       AND retry_count >= $2`,
    [STALE_DISPATCHING_MS, MAX_RETRY_COUNT]
  )

  // 3. Running too long -> orphaned.
  await pool.query(
    `UPDATE os_scheduled_tasks
     SET status = 'orphaned', updated_at = NOW()
     WHERE status = 'running'
       AND leased_at < NOW() - ($1 || ' milliseconds')::interval`,
    [ORPHAN_TIMEOUT_MS]
  )
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
    try {
      if (dispatcher.kill_worker) {
        await dispatcher.kill_worker({ tab_id: row.dispatched_tab_id })
      }
    } catch (e) {
      // Tolerate - tab may already be closed.
    }
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

// ── start ────────────────────────────────────────────────────────────────────
//
// Starts all three intervals. Wraps each in try/catch so one bad pass
// does not tank the entire loop.

exports.start = function start() {
  process.stderr.write('[scheduler] starting dispatch loop + completion poller + stale-lease recovery\n')

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

  // Unref so the intervals don't prevent process exit in test environments.
  if (dispatchInterval.unref) dispatchInterval.unref()
  if (completionInterval.unref) completionInterval.unref()
  if (staleInterval.unref) staleInterval.unref()

  return { dispatchInterval, completionInterval, staleInterval }
}
