'use strict'

// coord-retire - the retirement mechanism the coord inbox never had.
//
// WHY (2026-08-28, coord rebuild lane R1). chat.conductor.inbox held 5,838 unseen
// messages going back to 2026-07-20 and nothing in the system ever retired one.
// The only prior drain was a hand-run one-off on 2026-07-21 (it left
// ~/.ecodiaos/coordination/_drain-backup-2026-07-21 and no mechanism). A backlog
// that only grows made every read a paging problem, which is how the conductor
// went blind to worker completions for 39 days while every call returned 200.
//
// The shape that matters: of those 5,838, 5,605 were machine lifecycle telemetry
// (bound 2,797 / done 2,568 / progress 213 / account_switch 17) and 243 were
// things a conductor actually has to decide about. Signal density 4%. So the
// sweep is not "delete old messages"; it is "retire a lifecycle message once the
// row it describes has finished, and never touch an attention message by type".
//
// A lifecycle message is retired when ALL of these hold:
//   1. its body.type is lifecycle, not attention
//   2. it carries a task_id
//   3. the FIRE it describes is over. A row being terminal is the simple case,
//      but a cron row sits in 'active' between fires forever, so its history
//      would never retire under a status-only rule (measured: 1,636 of 5,856
//      messages held by 96 still-active cron rows). A lifecycle message is
//      equally settled when the row has fired AGAIN since it was written, so
//      last_run_at or leased_at newer than the message also retires it. If the
//      row is gone entirely, the message retires once it is older than
//      DANGLING_DAYS, so a hard-deleted dispatch cannot pin the backlog open.
//   4. it is older than grace_minutes, so a done that landed moments ago is
//      still on the conductor's next page
//
// Attention messages are NEVER retired by this rule. They are retired only by
// digest(), which writes their content somewhere durable FIRST and posts a
// pointer, so retiring one can never destroy the only copy.
//
// Fails toward the status quo: any error resolving a task's state leaves every
// message for that task unretired. Retiring nothing is always safe; retiring a
// live escalation is not.
//
// Doctrine: patterns/an-inbox-that-serves-oldest-first-goes-blind-as-it-fills-2026-08-28.md

const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
const coord = require('./coord')

const CONDUCTOR_TOPIC = 'chat.conductor.inbox'

// Machine telemetry about a scheduler row's lifecycle. Retirable once that row
// is finished, because the row itself is the durable record of what happened.
//
// 2026-08-28 lane R1 item 2 reshaped this set, and the reasoning per member
// matters more than the membership:
//
//   'bound', 'progress', 'done'  LEGACY DRAIN. Nothing produces these any more.
//     A worker's handshake is now a WRITE to its own os_scheduled_tasks row
//     (tools/task-signals.js), not a message. They stay in the set because
//     ~5,578 of them are still on disk and this sweep is the only thing that
//     will ever clear them. Removing them would strand exactly the backlog this
//     module was written to drain.
//
//   'worker_report'  THE LIVE MEMBER. signal_done still posts one purely so the
//     conductor wake surfaces "a worker finished" to a human. It accumulates at
//     the same rate `done` did, so it needs the same retirement rule; leaving it
//     out would rebuild the 5,838-message backlog under a new name.
//
//   'account_switch'  REMOVED, and it was never lifecycle. scripts/switch-run.js
//     posts one when the live Claude account rotates. It describes an ACCOUNT,
//     not a scheduler row, so it carries no task_id and rule 2 could never
//     retire it: all 17 were being walked and skipped on every sweep. As an
//     attention message it now reaches digest(), which writes its content
//     somewhere durable before retiring it. That is the correct home for a
//     message no row will ever settle.
const LIFECYCLE_TYPES = new Set(['bound', 'progress', 'done', 'worker_report'])

// A scheduler row in one of these states will never produce another event, so
// every lifecycle message about it is history. 'running' and 'active' are
// deliberately absent: a done for a row still marked running is exactly the
// message the conductor needs to reconcile it.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'orphaned', 'failed'])

const DEFAULT_GRACE_MINUTES = 60
const DANGLING_DAYS = 7

let _pool = null
function getPool() {
  if (!_pool) {
    const connStr = process.env.DATABASE_URL
    if (!connStr) throw new Error('coord-retire: DATABASE_URL env var is required')
    _pool = new Pool({ connectionString: connStr, keepAlive: true,
      connectionTimeoutMillis: 30_000, idleTimeoutMillis: 30_000, max: 2 })
  }
  return _pool
}
// Injection seam for the test suite, which must never touch the real DB.
function _setPool(p) { _pool = p }

function typeOf(m) { return ((m && m.body) || {}).type || null }
function taskIdOf(m) {
  const b = (m && m.body) || {}
  const t = b.task_id != null ? b.task_id : m.task_id
  return t == null ? null : String(t)
}

// Resolve fire-state for a set of task ids in ONE query. Returns a Map of
// id -> {terminal, status, lastRunMs, leasedMs}. An id with no row is reported
// status:null; the caller applies the dangling rule.
async function resolveTerminal(taskIds) {
  const ids = [...new Set(taskIds.filter(Boolean))]
  const out = new Map()
  if (!ids.length) return out
  const pool = getPool()
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const res = await pool.query(
      `SELECT id::text AS id, status, archived_at, last_run_at, leased_at
         FROM os_scheduled_tasks WHERE id::text = ANY($1::text[])`,
      [chunk]
    )
    for (const r of res.rows) {
      const terminal = TERMINAL_STATUSES.has(r.status) || r.archived_at != null
      out.set(r.id, { terminal, status: r.status,
        lastRunMs: r.last_run_at ? new Date(r.last_run_at).getTime() : null,
        leasedMs: r.leased_at ? new Date(r.leased_at).getTime() : null })
    }
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { terminal: false, status: null, lastRunMs: null, leasedMs: null })
  return out
}

// sweep({topic, grace_minutes, dry_run}) - retire settled lifecycle messages.
async function sweep(params) {
  params = params || {}
  const topic = params.topic || CONDUCTOR_TOPIC
  const grace = typeof params.grace_minutes === 'number' ? params.grace_minutes : DEFAULT_GRACE_MINUTES
  const dryRun = !!params.dry_run
  const now = Date.now()

  const unseen = coord._unseenForTopic(topic)
  const before = unseen.length

  const candidates = []
  const orphanNoTask = []
  const skipped = { attention: 0, no_task_id: 0, too_recent: 0 }
  for (const m of unseen) {
    const t = typeOf(m)
    if (!LIFECYCLE_TYPES.has(t)) { skipped.attention++; continue }
    const tid = taskIdOf(m)
    if (!tid) {
      // No task id at all, so no row will ever settle it: permanently unretirable
      // under the rule above and therefore pure sediment once it is genuinely old.
      // Same DANGLING_DAYS floor as a message whose row was hard-deleted.
      if ((now - new Date(m.created_at).getTime()) > DANGLING_DAYS * 86_400_000) {
        orphanNoTask.push(m.id)
      } else { skipped.no_task_id++ }
      continue
    }
    const ageMs = now - new Date(m.created_at).getTime()
    if (ageMs < grace * 60_000) { skipped.too_recent++; continue }
    candidates.push({ m, tid, ageMs, createdMs: new Date(m.created_at).getTime() })
  }

  let states
  try {
    states = await resolveTerminal(candidates.map(c => c.tid))
  } catch (e) {
    // Fail toward the status quo: no state, no retirement.
    return { ok: false, error: 'task-state lookup failed: ' + (e && e.message || e),
      topic, unseen_before: before, retired: 0, unseen_after: before }
  }

  const retire = [...orphanNoTask]
  const held = { current_fire: 0, dangling_too_fresh: 0 }
  for (const c of candidates) {
    const st = states.get(c.tid) || { terminal: false, status: null }
    if (st.terminal) { retire.push(c.m.id); continue }
    if (st.status === null) {
      // No scheduler row at all. History, but only once it is genuinely old.
      if (c.ageMs > DANGLING_DAYS * 86_400_000) retire.push(c.m.id)
      else held.dangling_too_fresh++
      continue
    }
    // Row still live. The message is history anyway if a LATER fire has since
    // started or finished on that row, which is the normal case for a cron.
    const superseded = (st.lastRunMs && st.lastRunMs > c.createdMs) ||
                       (st.leasedMs && st.leasedMs > c.createdMs)
    if (superseded) { retire.push(c.m.id); continue }
    held.current_fire++
  }

  const retired = dryRun ? 0 : coord._markSeenByIds(retire, 'retired by coord-retire.sweep: task row terminal')
  return {
    ok: true, topic, dry_run: dryRun,
    unseen_before: before,
    retirable: retire.length,
    retired,
    unseen_after: before - retired,
    skipped, held,
  }
}

// digest({topic, older_than_days, out_dir}) - retire STALE ATTENTION messages by
// writing their full content to one dated file first, then marking them seen and
// posting a single pointer message. Content is written and fsync-visible BEFORE
// anything is marked, so a crash mid-sweep loses nothing.
async function digest(params) {
  params = params || {}
  const topic = params.topic || CONDUCTOR_TOPIC
  const days = typeof params.older_than_days === 'number' ? params.older_than_days : 7
  const dryRun = !!params.dry_run
  const outDir = params.out_dir || path.join(process.env.HOME || '/tmp', '.ecodiaos', 'coordination', 'digests')
  const cutoff = Date.now() - days * 86_400_000

  const stale = coord._unseenForTopic(topic)
    .filter(m => !LIFECYCLE_TYPES.has(typeOf(m)))
    .filter(m => new Date(m.created_at).getTime() < cutoff)

  if (!stale.length) return { ok: true, topic, digested: 0, note: 'no stale attention messages' }
  if (dryRun) return { ok: true, topic, dry_run: true, digestable: stale.length }

  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const file = path.join(outDir, 'attention-digest-' + stamp + '.jsonl')
  const fd = fs.openSync(file, 'a')
  try {
    for (const m of stale) fs.writeSync(fd, JSON.stringify(m) + '\n')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }

  const marked = coord._markSeenByIds(stale.map(m => m.id), 'digested to ' + file)
  return { ok: true, topic, digested: marked, digest_file: file,
    oldest: stale[0] && stale[0].created_at, newest: stale[stale.length - 1] && stale[stale.length - 1].created_at }
}

// status - unseen counts split the way the rebuild splits the bus, so a canary
// can alarm on attention backlog without lifecycle noise drowning it.
async function status(params) {
  params = params || {}
  const topic = params.topic || CONDUCTOR_TOPIC
  const unseen = coord._unseenForTopic(topic)
  const byType = {}
  let lifecycle = 0, attention = 0
  for (const m of unseen) {
    const t = typeOf(m) || 'null'
    byType[t] = (byType[t] || 0) + 1
    if (LIFECYCLE_TYPES.has(t)) lifecycle++; else attention++
  }
  return { ok: true, topic, unseen: unseen.length, lifecycle, attention, by_type: byType,
    oldest: unseen[0] && unseen[0].created_at, newest: unseen[unseen.length - 1] && unseen[unseen.length - 1].created_at }
}

module.exports = {
  sweep, digest, status,
  _setPool, _resolveTerminal: resolveTerminal,
  _LIFECYCLE_TYPES: LIFECYCLE_TYPES, _TERMINAL_STATUSES: TERMINAL_STATUSES,
}
