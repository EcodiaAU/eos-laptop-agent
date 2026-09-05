'use strict'

// dispatch-settle - give the dispatch lifecycle a terminal state that means something.
//
// WHY (2026-09-05, lane C1). Terminal state depended on a cooperating worker that
// is dead most of the time. Measured over 14 days of one-shot rows: 194 leased,
// 84 bound, 18 reported done, 163 ended 'orphaned'. That word carries three
// different facts and distinguishes none of them:
//   89  never bound at all           the Mac failed to launch a tab
//   68  bound, left a progress note  the worker ran, worked, and died before signalling
//    2  bound, left nothing          ran and vanished
// And 70 of the 70 bound orphans DID leave a progress_summary. The trace was
// always there. Only the terminal state was missing, so the work was invisible
// whether or not it had actually been done.
//
// WHAT THIS DOES NOT DO, and the reason it is built this way. It never writes
// done_at and never writes 'completed'. A reconciler that infers completion is a
// gate that cannot fail: the 68 half-finished jobs would read as done and never be
// retried, and the substrate would lie in the direction of comfort, which is
// strictly worse than the silence it replaces. Migration 168 enforces that in the
// database rather than trusting this file: writing settled_at and done_at in one
// statement raises, and a real worker signal arriving after a settle WITHDRAWS the
// settle instead of being refused. Real evidence always beats inferred evidence.
//
// THE VERDICT IS AN HONEST THREE-WAY. 'cannot-tell' is a first-class answer, not a
// failure to try. By construction every row here failed to reach its own
// signal_done, so "did it finish the work" is not observable from outside; what IS
// observable is whether it reached the last step BEFORE that close. The
// self-continuation clause every dispatch brief carries makes a worker arm a
// successor row on its own lane as its final act before signalling, so a successor
// armed inside the run window is a real, mechanical signal that the worker got to
// the end of its arc. Absent that, a trace means work happened and stopped, which
// is 'died-midway', which is the answer that keeps the job visible.
//
// Doctrine: patterns/orphaned-is-not-a-terminal-state-2026-09-05.md

const { execFileSync } = require('child_process')
const path = require('path')

// A row younger than this is never settled, whatever a probe says. The liveness
// oracle's own confirmation window is 60 minutes; this sits decisively past it so
// a slow worker inside one long build is never annotated as a corpse. It is not
// the safety mechanism (migration 168's withdraw clause is), it is the cheap
// first line that means the withdraw clause almost never has to fire.
const SETTLE_MIN_AGE_MS = 2 * 60 * 60 * 1000

// How many rows one pass will settle. Bounded so the first pass over a backlog of
// hundreds cannot hold the tick open, and so a bug in classification damages a
// batch rather than the whole table before anyone reads the log.
const SETTLE_BATCH = 40

// C-i: how many times a row that leased but never bound is relaunched before the
// fleet stops trying and says so loudly. A never-bound row is the Mac failing, not
// the job failing, so the first instinct is to retry forever; that instinct is the
// pre-mortem's second failure, where a capped account turns retry into a loop that
// burns the remaining quota relaunching a tab that cannot start. Three attempts
// covers a transient IDE or memory blip and stops well short of a storm.
const MAX_LAUNCH_RETRIES = 3

// Backoff between relaunch attempts. Exponential on the attempt already made, so
// 5m, 20m, 80m: long enough that a memory-pressure window passes, short enough
// that a one-shot job dispatched in the morning still runs that morning.
function launchBackoffMs(attemptsSoFar) {
  return 5 * 60 * 1000 * Math.pow(4, Math.max(0, attemptsSoFar))
}

function gitIn(tree, args) {
  try {
    return execFileSync('git', ['-C', tree].concat(args), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim()
  } catch (e) { return null }
}

// Commits the worker actually made on its own branch. `git worktree remove` does
// NOT delete the branch ref, so this survives the prune that destroys the worktree
// itself, which is what makes it usable as evidence about a run that is long over.
// Measured 2026-09-05: 3,896 local worker/* refs and 273 pushed.
function workerBranchEvidence(tree, rowId) {
  const branch = 'worker/' + String(rowId)
  const head = gitIn(tree, ['rev-parse', '--verify', '--quiet', branch])
  if (!head) return { branch, exists: false, commits: 0, last_commit_at: null, pushed: false }
  // Commits on the branch that main does not have: the work, minus the base.
  const countRaw = gitIn(tree, ['rev-list', '--count', 'main..' + branch])
  const lastRaw = gitIn(tree, ['log', '-1', '--format=%ct', branch])
  const pushed = !!gitIn(tree, ['rev-parse', '--verify', '--quiet', 'origin/' + branch])
  return {
    branch,
    exists: true,
    commits: countRaw === null ? null : parseInt(countRaw, 10),
    last_commit_at: lastRaw ? new Date(parseInt(lastRaw, 10) * 1000).toISOString() : null,
    pushed,
  }
}

// Did the worker reach its self-continuation step? A successor armed on the SAME
// lane, created inside the run window, is the last thing a worker does before it
// signals done, so its presence is the one mechanical signal available that the
// arc completed. Keyed on the lane rather than the name because the whole point of
// a successor is that it varies the suffix.
async function successorEvidence(pool, row) {
  if (!row.name) return { checked: false, found: 0 }
  const from = row.bound_at || row.leased_at
  if (!from) return { checked: false, found: 0 }
  try {
    const r = await pool.query(
      `SELECT id, name, created_at FROM os_scheduled_tasks
        WHERE id <> $1
          AND os_sched_lane_key(name) IS NOT NULL
          AND os_sched_lane_key(name) = os_sched_lane_key($2)
          AND created_at >= $3
          AND created_at <= COALESCE($4, NOW())
        ORDER BY created_at ASC LIMIT 5`,
      [row.id, row.name, from, row.last_run_at]
    )
    return { checked: true, found: r.rows.length, names: r.rows.map(x => x.name) }
  } catch (e) {
    return { checked: false, found: 0, error: e.message }
  }
}

// classify(row, ev) -> { status, verdict }
//
// Pure, so the whole judgement is testable without a database. The ordering is
// deliberate: launch failure is checked FIRST because a row that never bound has
// no worker to have left a trace, and reading its empty trace as "died having done
// nothing" would blame the job for the Mac's failure.
function classify(row, ev) {
  if (!row.bound_at) {
    return { status: 'settled-no-trace', verdict: 'launch-failure' }
  }
  const hasProgress = !!(row.progress_summary && String(row.progress_summary).trim())
  const hasCommits = !!(ev.branch && ev.branch.exists && ev.branch.commits > 0)
  const hasSuccessor = !!(ev.successor && ev.successor.found > 0)

  if (!hasProgress && !hasCommits && !hasSuccessor) {
    return { status: 'settled-no-trace', verdict: 'no-trace' }
  }
  if (hasSuccessor) {
    // It armed its own continuation, which is the step immediately before the
    // close it never reached. That is as close to "finished" as anything
    // observable from outside gets.
    return { status: 'settled-with-trace', verdict: 'finished-and-died' }
  }
  if (hasProgress && hasCommits) {
    // Work happened and landed, and it never reached its own last step.
    return { status: 'settled-with-trace', verdict: 'died-midway' }
  }
  // One signal and not the other. Enough to say something happened, not enough to
  // say what, and saying so is the point.
  return { status: 'settled-with-trace', verdict: 'cannot-tell' }
}

// settleReconcilerPass - annotate the corpses, decide nothing about the living.
async function settleReconcilerPass(opts) {
  opts = opts || {}
  const scheduler = opts.scheduler || require('./scheduler')
  const pool = opts.pool || (scheduler.getPool ? scheduler.getPool() : scheduler._poolForLiveness())
  const liveness = opts.liveness || require('./worker-liveness')
  const tree = opts.sharedTree || process.env.SCHEDULER_SHARED_TREE ||
    path.join(require('os').homedir(), '.code', 'ecodiaos', 'backend')
  const nowMs = opts.now_ms || Date.now()
  const limit = opts.limit || SETTLE_BATCH
  const minAgeMs = typeof opts.min_age_ms === 'number' ? opts.min_age_ms : SETTLE_MIN_AGE_MS

  // Test seam. The verify gate needs to run the REAL pass against the REAL table
  // without also settling the live backlog in the same breath, and a gate that
  // exercises a copy of the logic proves nothing about the logic that ships.
  const onlyIds = Array.isArray(opts.only_ids) && opts.only_ids.length ? opts.only_ids : null
  const res = await pool.query(
    `SELECT id, name, type, cron_expression, status, leased_at, last_run_at,
            dispatched_tab_id, bound_at, bound_tab_id, done_at,
            progress_at, progress_summary, launch_retry_count
       FROM os_scheduled_tasks
      WHERE status = 'orphaned'
        AND archived_at IS NULL
        AND settled_at IS NULL
        AND done_at IS NULL
        AND leased_at IS NOT NULL
        AND leased_at < $1
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      ORDER BY leased_at DESC
      LIMIT $2`,
    [new Date(nowMs - minAgeMs).toISOString(), limit, onlyIds]
  )
  if (!res.rows.length) return { scanned: 0, settled: 0, skipped_live: 0, verdicts: [] }

  // Belt and braces on pre-mortem 3. These rows are already terminal by the
  // scheduler's own reckoning, so this cannot save a worker that is about to be
  // killed; it exists so a settle is never written over a session that is somehow
  // still writing turns. Only a POSITIVE 'live' stops the settle: 'unknown' on a
  // two-hour-old row that the scheduler already orphaned is not evidence of life.
  let verdicts = []
  try {
    verdicts = liveness.probeRows(res.rows, { now_ms: nowMs })
  } catch (e) {
    process.stderr.write('[settle] liveness probe failed, settling nothing: ' + e.message + '\n')
    return { scanned: res.rows.length, settled: 0, skipped_live: 0, error: e.message, verdicts: [] }
  }
  const liveById = new Map(verdicts.map(v => [String(v.id), v]))

  let settled = 0, skippedLive = 0
  const out = []
  for (const row of res.rows) {
    const lv = liveById.get(String(row.id))
    if (lv && lv.verdict === 'live') {
      skippedLive++
      process.stderr.write('[settle] refusing ' + row.id + ' (' + (row.name || '?') +
        '): worker is LIVE (' + lv.reason + ')\n')
      out.push({ id: row.id, name: row.name, action: 'refused-live', reason: lv.reason })
      continue
    }

    const ev = {
      liveness_verdict: lv ? lv.verdict : 'not-probed',
      liveness_reason: lv ? lv.reason : null,
      transcript: lv ? lv.evidence : null,
      progress_summary: row.progress_summary ? String(row.progress_summary).slice(0, 600) : null,
      progress_at: row.progress_at,
      bound_at: row.bound_at,
      branch: workerBranchEvidence(tree, row.id),
      settled_by: 'dispatch-settle.settleReconcilerPass',
      settled_from_status: 'orphaned',
    }
    ev.successor = await successorEvidence(pool, row)
    const c = classify(row, ev)
    if (c.verdict === 'launch-failure') {
      ev.launch_failure = true
      ev.note = 'leased but never bound: the tab did not boot. This is the Mac failing to launch, not the job failing.'
    }

    // Guarded so a row that moved under us is a no-op rather than a clobber.
    const upd = await pool.query(
      `UPDATE os_scheduled_tasks
          SET status = $2, settled_at = NOW(), settle_verdict = $3,
              settle_evidence = $4::jsonb, updated_at = NOW()
        WHERE id = $1
          AND status = 'orphaned'
          AND settled_at IS NULL
          AND done_at IS NULL
          AND archived_at IS NULL
        RETURNING id`,
      [row.id, c.status, c.verdict, JSON.stringify(ev)]
    )
    if (!upd.rows.length) {
      out.push({ id: row.id, name: row.name, action: 'no-op-row-moved' })
      continue
    }
    settled++
    out.push({ id: row.id, name: row.name, action: 'settled', status: c.status, verdict: c.verdict })
  }
  return { scanned: res.rows.length, settled, skipped_live: skippedLive, verdicts: out }
}

// launchFailureDecision - C-i, and it is a decision rather than a write so the
// caller inside livenessReapPass stays readable and this stays testable.
//
// A dead one-shot that never bound did not fail: it never started. Relaunch it
// under a ceiling. Three refusals, each a real failure mode rather than a
// theoretical one:
//   capped    relaunching into an all-accounts cap is the fire loop that burns the
//             quota that would have let the NEXT job run.
//   lane held relaunching flips orphaned -> active, which fires the migration 150
//             lane-revive arm and SUPERSEDES whatever holds the lane. That is the
//             exact class that cancelled a client deadline deadman on 2026-08-29.
//             Migration 153's BEFORE arm refuses it, so the write would raise;
//             this checks first so the tick never has to catch it.
//   ceiling   past MAX_LAUNCH_RETRIES the Mac is not having a blip, it is out of
//             capacity, and quietly retrying forever hides a degraded fleet.
function launchFailureDecision(row, ctx) {
  ctx = ctx || {}
  const attempts = Number(row.launch_retry_count || 0)
  if (ctx.capped) {
    return { action: 'defer', reason: 'all accounts capped: a relaunch now burns the quota the next job needs' }
  }
  if (ctx.laneHeld) {
    return { action: 'defer', reason: 'lane ' + (ctx.laneKey || '?') + ' is held by a live row; a revive would supersede it' }
  }
  if (attempts >= MAX_LAUNCH_RETRIES) {
    return {
      action: 'escalate',
      reason: 'launch failed ' + attempts + ' times: the Mac cannot open a tab for this row',
      attempts,
    }
  }
  return {
    action: 'relaunch',
    attempts: attempts + 1,
    next_run_at: new Date((ctx.now_ms || Date.now()) + launchBackoffMs(attempts)).toISOString(),
    reason: 'leased but never bound: launch failure, relaunch ' + (attempts + 1) + ' of ' + MAX_LAUNCH_RETRIES,
  }
}

module.exports = {
  settleReconcilerPass,
  classify,
  launchFailureDecision,
  workerBranchEvidence,
  successorEvidence,
  launchBackoffMs,
  SETTLE_MIN_AGE_MS, SETTLE_BATCH, MAX_LAUNCH_RETRIES,
}
