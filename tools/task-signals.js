// task-signals.js - the dispatch handshake, written to the scheduler's own row.
//
// WHY THIS MODULE EXISTS (2026-08-28, lane R1 scope item 2).
//
// A dispatched worker used to tell the scheduler it had come up, and later that
// it had finished, by posting a message to the coord FILE BUS at
// chat.conductor.inbox with body.type 'bound' / 'done' / 'progress'. The
// scheduler then read that bus back to learn about its own rows: dispatchOne
// polled coord.peek_inbox for a matching 'bound' while holding the launch lock,
// and completionPass called coord.scanTopicByType for a matching 'done'.
//
// That bus is shared with the interactive conductor, is append-only, and orders
// oldest-first. Five separate race fixes landed on top of it between June and
// July 2026 (the seen-flag race, its conductor-perception sibling, the
// oldest-first starvation window, the fast-worker done-without-bound case, and
// the stable-task_id stale-done case). Every one of them was a heuristic
// compensating for two structural facts: the signal carried no identity tying it
// to ONE dispatch, and its read-state was owned by another process.
//
// Here the signal lands on the row it is about, in the table the scheduler
// already owns. Two rules replace all five heuristics:
//
//   CLEARED AT DISPATCH.  dispatchOne blanks every lifecycle column in the same
//     guarded UPDATE that stamps dispatched_tab_id. Nothing accumulates, so
//     there is no stale signal to fresh-gate and no backlog to starve a window.
//
//   GUARDED ON THE OWNING TAB.  Every write below carries the caller's tab id
//     and applies only WHERE dispatched_tab_id = that tab. A signal from a prior
//     fire's worker, or from a tab that does not own the row, matches ZERO rows
//     and is refused by name. That identity check is what the leased_at
//     freshness gate was approximating, and unlike the gate it cannot be
//     defeated by a clock, a margin, or a slow dispatch.
//
// THE POOL SEAM. This module deliberately does NOT build its own pg Pool. It
// borrows the scheduler's via _poolForLiveness(), exactly as tools/worker-
// liveness.js does. Two reasons. index.js mounts routes/mcpCoord (the surface
// workers call) UNCONDITIONALLY but only loads tools/scheduler when
// SCHEDULER_ENABLED === 'true', so a second pool here would connect in a process
// that has no dispatch loop and therefore no rows to signal about. And a second
// pool against the same Supavisor endpoint doubles the connection footprint for
// no benefit. The require is INSIDE the function, not at module load, so
// coord.js can require this file without creating a cycle with scheduler.js
// (which requires coord.js at its top level).
//
// FAILURE POSTURE IS LOUD, NOT SILENT. If no pool is reachable, or the row does
// not match, these return { ok: false, error: <named> }. They never resolve
// ok:true on a write that did not land. A silently-dropped bound costs the fleet
// a full SIGNAL_BOUND_TIMEOUT of launch-lock hold; a silently-dropped done rots
// the row to the 6h orphan sweep. Both are invisible failures, which is the
// exact shape this lane keeps finding, so the absence of the write is the thing
// the gate asserts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Test seam. When set, used in preference to the scheduler's pool.
let _pool = null
exports._setPool = function (p) { _pool = p }

// Borrow the scheduler's pool. Returns null rather than throwing: _poolForLiveness
// throws when DATABASE_URL is unset, and a worker signal must degrade to a named
// refusal rather than a 500 out of the MCP surface.
function getPool() {
  if (_pool) return _pool
  try {
    const scheduler = require('./scheduler')
    if (typeof scheduler._poolForLiveness !== 'function') return null
    return scheduler._poolForLiveness() || null
  } catch (e) {
    return null
  }
}
exports._getPool = getPool

// Shared preamble for all three writers. Every rejection here is a NAMED reason,
// because "it did not land" and "it landed somewhere else" need to be
// distinguishable in a log six hours later.
function precheck(taskId, tabId) {
  if (!taskId) return { ok: false, error: 'task_signals: task_id is required' }
  if (!UUID_RE.test(String(taskId))) {
    // Guard in JS rather than letting Postgres raise 22P02 on the cast. An
    // invalid-uuid error thrown out of the MCP handler reads as a server fault;
    // a named refusal reads as what it is, a caller passing the wrong id.
    return { ok: false, error: 'task_signals: task_id is not a uuid: ' + String(taskId).slice(0, 64) }
  }
  if (!tabId) {
    // No caller identity means no way to prove this signal belongs to the
    // current dispatch. Refusing is the whole point of the guard.
    return { ok: false, error: 'task_signals: caller tab_id is required (a signal must prove it owns the row)' }
  }
  const pool = getPool()
  if (!pool) return { ok: false, error: 'task_signals: no database pool available (scheduler not loaded or DATABASE_URL unset)' }
  return { ok: true, pool }
}

// Common tail. rowCount 0 is the guard firing, and it is NOT an error condition
// in the exceptional sense: it is the designed refusal. It still returns
// ok:false, because a caller that treats a refused write as a success is exactly
// the laundering this module exists to stop.
async function applyGuarded(pool, sql, params, taskId, tabId, what) {
  try {
    const res = await pool.query(sql, params)
    if (!res || res.rowCount === 0) {
      return {
        ok: false,
        refused: true,
        error: 'task_signals: ' + what + ' refused - task ' + taskId +
               ' is not currently dispatched to tab ' + tabId,
      }
    }
    return { ok: true, task_id: taskId, tab_id: tabId }
  } catch (e) {
    return { ok: false, error: 'task_signals: ' + what + ' failed: ' + (e && e.message || String(e)) }
  }
}

// bound - the worker has launched, read its brief and reached MCP. This is what
// releases dispatchOne's launch lock, so a lost one costs a full
// SIGNAL_BOUND_TIMEOUT_MS of serialised dispatch for the whole fleet.
exports.recordBound = async function recordBound(params) {
  params = params || {}
  const taskId = params.task_id
  const tabId = params.tab_id
  const pre = precheck(taskId, tabId)
  if (!pre.ok) return pre
  return applyGuarded(
    pre.pool,
    `UPDATE os_scheduled_tasks
        SET bound_at = NOW(), bound_tab_id = $2, updated_at = NOW()
      WHERE id = $1::uuid
        AND dispatched_tab_id = $2`,
    [String(taskId), String(tabId)],
    taskId, tabId, 'bound'
  )
}

// done - terminal. status is load-bearing and MUST survive: markComplete reads
// it to choose success vs failure, and when it was dropped on the bus in
// 2026-06-09 every single cron looked like a failure (48/48 rows carried
// last_error, 0 clean successes). It is stored as its own column here rather
// than nested in a blob for exactly that reason.
exports.recordDone = async function recordDone(params) {
  params = params || {}
  const taskId = params.task_id
  const tabId = params.tab_id
  const pre = precheck(taskId, tabId)
  if (!pre.ok) return pre
  return applyGuarded(
    pre.pool,
    `UPDATE os_scheduled_tasks
        SET done_at = NOW(), done_status = $3, done_summary = $4,
            done_pointer = $5, updated_at = NOW()
      WHERE id = $1::uuid
        AND dispatched_tab_id = $2`,
    [
      String(taskId),
      String(tabId),
      String(params.status || 'success'),
      params.result_summary == null ? null : String(params.result_summary).slice(0, 4000),
      params.result_pointer == null ? null : String(params.result_pointer).slice(0, 1000),
    ],
    taskId, tabId, 'done'
  )
}

// progress - advisory only. Nothing in the dispatch path reads it; it exists so
// an operator can see a long worker is still moving without opening its tab.
// Single-valued on purpose: the LAST progress line, not a log. A worker that
// wants a durable trail writes it to the substrate the brief names.
exports.recordProgress = async function recordProgress(params) {
  params = params || {}
  const taskId = params.task_id
  const tabId = params.tab_id
  const pre = precheck(taskId, tabId)
  if (!pre.ok) return pre
  return applyGuarded(
    pre.pool,
    `UPDATE os_scheduled_tasks
        SET progress_at = NOW(), progress_summary = $3, updated_at = NOW()
      WHERE id = $1::uuid
        AND dispatched_tab_id = $2`,
    [
      String(taskId),
      String(tabId),
      params.summary == null ? null : String(params.summary).slice(0, 2000),
    ],
    taskId, tabId, 'progress'
  )
}

// The column list dispatchOne blanks and the wait reads back. Kept here so the
// writer and the reader cannot drift apart across two files.
exports.LIFECYCLE_COLUMNS = [
  'bound_at', 'bound_tab_id',
  'done_at', 'done_status', 'done_summary', 'done_pointer',
  'progress_at', 'progress_summary',
]

// The SET fragment dispatchOne uses to clear the slate for a new dispatch.
// Written as a constant rather than built from LIFECYCLE_COLUMNS at call time so
// it is greppable and so no parameter numbering can shift under it.
exports.CLEAR_SQL_FRAGMENT =
  'bound_at = NULL, bound_tab_id = NULL, ' +
  'done_at = NULL, done_status = NULL, done_summary = NULL, done_pointer = NULL, ' +
  'progress_at = NULL, progress_summary = NULL'
