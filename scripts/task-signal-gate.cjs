// task-signal-gate.cjs - proves the worker handshake BOTH ways, on the real table.
//
// THE QUESTION THIS GATE ASKS is not "does dispatch still work". A handshake has
// two failure directions and a one-directional gate cannot tell them apart:
//
//   RELEASES WHEN IT SHOULD NOT  -> the launch lock opens without a worker, tabs
//                                   flood, and two arcs run the same job.
//   NEVER RELEASES               -> every dispatch in the fleet serialises behind
//                                   a full SIGNAL_BOUND_TIMEOUT_MS of dead wait.
//
// A gate that only proves "a bound releases the lock" scores a lock that was
// never engaged exactly as green as a working one. So section D drives the real
// dispatchOne end to end and measures BOTH: it releases on a legitimate bind, and
// it does NOT release on a bind from a tab that does not own the row.
//
// EVERY REFUSAL LEG ASSERTS THE ABSENCE OF THE WRITE, not the presence of an
// error. On this same lane, 2026-08-28, a deliberate breakage that made a refusal
// quietly file the message anyway left EVERY "REFUSED" assertion passing; only an
// on-disk count caught it. `ok === false` is not evidence that nothing happened.
//
// SECTION A IS POSITIVE AND RUNS FIRST. Without it, an implementation that
// refused everything (a crashed require, a typo'd predicate, an unset pool) would
// sail through every refusal leg below. A crash and a refusal are both a falsy
// ok with something in .error.
//
// The claim statement under test is EXTRACTED FROM dispatchOne's shipped source
// at runtime rather than retyped here, so this cannot pass against a statement
// that has since been edited away (same technique as conductor-claim-gate.cjs and
// lane-defer-gate.cjs).
//
// EVERYTHING runs inside ONE transaction that always ROLLS BACK, and the probe
// row is pinned to next_run_at 2030 besides, so the live 30s dispatch loop can
// never see it and no tab can open. Rows are addressed by id, never by name.
//
// Run: node scripts/task-signal-gate.cjs
// Exit 0 = all legs pass. Exit 1 = a leg failed. Exit 2 = the gate CRASHED,
// which is deliberately distinct: a crash must never be readable as a refusal.

// BOTH of these must be set BEFORE dotenv and before any require below.
//
// The bind timeout: section D deliberately runs waits that must NOT release, and
// the deployed value is 180s, so three of them would take nine minutes. dotenv
// does not override an already-set variable, which is exactly why this goes
// first. Set GATE_BOUND_TIMEOUT_MS to run the legs at the deployed budget.
//
// 2026-08-29 verification pass: raised 3000 -> 6000. Section D's RELEASE legs
// (D1, D9) assert wall-clock elapsed < budget, and wall clock cannot tell a
// released lock from a stalled query. Steady-state round-trip to this database
// is p50 36ms / max 54ms over 40 samples, so the budget was never the systematic
// problem; the observed failures were single-query STALLS of ~2s and ~9s
// (D9 3223ms of 3000ms, D1 10449ms of 3000ms) against a pooler the live daemon
// also uses. A legitimate release costs about one 1000ms poll, so 6000 buys real
// headroom over a 2s stall. It does NOT eliminate the floor: a stall longer than
// the budget still reads as a held lock, so an isolated D1/D9 failure with every
// other leg green is a stall, not a regression - re-run before believing it.
process.env.SCHEDULER_SIGNAL_BOUND_TIMEOUT_MS = process.env.GATE_BOUND_TIMEOUT_MS || '6000'

// COORD_ROOT: section D calls the real coord.signal_done, which still posts a
// worker_report notice to the file substrate. Without this the gate would write
// notices into the LIVE ~/.ecodiaos/coordination inbox that the running
// laptop-agent owns, which is the substrate this whole lane is trying to stop
// filling with machine sediment.
const os = require('os')
const fsx = require('fs')
const OWNED_COORD_ROOT = process.env.COORD_ROOT
  ? null
  : fsx.mkdtempSync(require('path').join(os.tmpdir(), 'task-signal-gate-'))
process.env.COORD_ROOT = process.env.COORD_ROOT || OWNED_COORD_ROOT
// Close what you opened. Only the directory THIS run created, never one handed in.
process.on('exit', () => {
  if (OWNED_COORD_ROOT) { try { fsx.rmSync(OWNED_COORD_ROOT, { recursive: true, force: true }) } catch (e) {} }
})
process.env.COORD_DISABLE_SWEEP = '1'

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { Pool } = require('pg')
const scheduler = require('../tools/scheduler')
const taskSignals = require('../tools/task-signals')
const coord = require('../tools/coord')
const creds = require('../tools/creds')

const OWNER_TAB = 'tab_signalgate_owner'
const OTHER_TAB = 'tab_signalgate_other'
const FAR_FUTURE = '2030-01-01T00:00:00Z'
const LANE = 'cowork.signalgate-lane-Z9'

let pass = 0, fail = 0
const ok = (c, l) => { c ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l)) }

// -- extract the SHIPPED claim statement out of dispatchOne -------------------
// Bounded to the block it belongs to. An extractor that can wander past its own
// block matches an unrelated later statement with a different parameter count and
// dies on a Postgres bind error instead of reporting a failed leg (measured on
// this lane, 2026-08-28).
const SRC = scheduler.dispatchOne.toString()
const MARK = '3b. CLAIM THE ROW FOR THIS DISPATCH'
const iMark = SRC.indexOf(MARK)
const iEnd = (() => {
  const e = SRC.indexOf('4. Wait for signal_bound', iMark < 0 ? 0 : iMark)
  return e > -1 ? e : SRC.length
})()
const BLOCK = iMark < 0 ? '' : SRC.slice(iMark, iEnd)
function shippedStatement(pred) {
  if (!BLOCK) return null
  let i = 0
  for (;;) {
    const a = BLOCK.indexOf('`', i); if (a < 0) return null
    const b = BLOCK.indexOf('`', a + 1); if (b < 0) return null
    const body = BLOCK.slice(a + 1, b)
    if (pred(body)) return body
    i = b + 1
  }
}
// The ADOPT statement (dispatchOne step 2d, the 2026-07-17 double-spawn guard)
// lives BEFORE the 3b block, so it needs its own extractor over the whole source.
// Extracted rather than retyped for the same reason as the claim: a gate that
// replays a hand-copied statement measures the copy, and section G's whole point
// is that this transition reaches running WITHOUT the claim's clear. Retyping it
// here would have scored a clear-at-adopt fix exactly as green as a correct one.
function shippedStatementIn(src, pred) {
  let i = 0
  for (;;) {
    const a = src.indexOf('`', i); if (a < 0) return null
    const b = src.indexOf('`', a + 1); if (b < 0) return null
    const body = src.slice(a + 1, b)
    if (pred(body)) return body
    i = b + 1
  }
}
const UPD_ADOPT_RAW = shippedStatementIn(SRC, b =>
  /UPDATE\s+os_scheduled_tasks/.test(b) && /SET status = 'running', dispatched_tab_id = \$1/.test(b))
const UPD_ADOPT = UPD_ADOPT_RAW
  ? UPD_ADOPT_RAW.replace('${taskSignals.CLEAR_SQL_FRAGMENT}', taskSignals.CLEAR_SQL_FRAGMENT)
  : null

const UPD_CLAIM_RAW = shippedStatement(b => /UPDATE\s+os_scheduled_tasks/.test(b) && /dispatched_tab_id\s*=\s*\$1/.test(b))
// The shipped statement interpolates the clear-list from the module that owns it,
// so the raw source carries the template token rather than the column names.
// Assert the token IS there (deleting the interpolation must fail this gate),
// then expand it exactly as the running code does, and check the EXPANSION for
// all eight columns. Checking the raw source alone would report all eight
// missing on a perfectly correct statement; checking only the expansion would
// pass even if dispatchOne had stopped clearing anything at all.
const CLEAR_TOKEN = '${taskSignals.CLEAR_SQL_FRAGMENT}'
const CLAIM_INTERPOLATES = !!UPD_CLAIM_RAW && UPD_CLAIM_RAW.indexOf(CLEAR_TOKEN) !== -1
const UPD_CLAIM = UPD_CLAIM_RAW
  ? UPD_CLAIM_RAW.replace(CLEAR_TOKEN, require('../tools/task-signals').CLEAR_SQL_FRAGMENT)
  : null

// The eight columns the claim must blank. Read from the module that owns them so
// a column added there without being cleared fails here rather than silently
// carrying a stale signal into the next dispatch.
const LIFECYCLE = taskSignals.LIFECYCLE_COLUMNS

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30_000 })
  const client = await pool.connect()
  let taskId = null
  try {
    await client.query('BEGIN')

    // Both the scheduler and the signal sink write through THIS transaction, so
    // the gate exercises the real end-to-end path (coord -> task-signals -> the
    // same rows dispatchOne polls) and every write disappears on rollback.
    const txPool = { query: (sql, params) => client.query(sql, params) }
    scheduler._setPool(txPool)
    taskSignals._setPool(txPool)

    // ── PRE: the shipped statement is present and has the shape claimed ──────
    console.log('\nPRE. the claim statement exists in the shipped dispatchOne')
    ok(!!UPD_CLAIM, 'PRE1. dispatchOne still contains the dispatch-claim UPDATE')
    if (!UPD_CLAIM) {
      console.log('\n  the claim statement is gone; every leg below would be measuring nothing')
      console.log('\n' + pass + ' passed, ' + fail + ' failed')
      await client.query('ROLLBACK'); client.release(); await pool.end()
      process.exit(1)
    }
    ok(/AND status = 'dispatching'/.test(UPD_CLAIM),
      'PRE2. the claim is guarded on status=dispatching')
    ok(/leased_by IS NOT DISTINCT FROM/.test(UPD_CLAIM),
      'PRE3. the claim is guarded on still owning the lease')
    ok(CLAIM_INTERPOLATES,
      'PRE4. the claim still interpolates task-signals CLEAR_SQL_FRAGMENT (deleting it must fail here)')
    const missing = LIFECYCLE.filter(c => !new RegExp(c + '\\s*=\\s*NULL').test(UPD_CLAIM))
    ok(missing.length === 0,
      'PRE5. the expanded claim blanks ALL ' + LIFECYCLE.length + ' lifecycle columns' +
      (missing.length ? ' (missing: ' + missing.join(',') + ')' : ''))

    // ── probe row, pinned far future, addressed by id from here on ──────────
    const ins = await client.query(
      `INSERT INTO os_scheduled_tasks (name, type, prompt, status, next_run_at, run_count)
       VALUES ($1, 'delayed', 'task-signal-gate probe', 'active', $2, 0) RETURNING id`,
      [LANE + '-probe', FAR_FUTURE]
    )
    taskId = ins.rows[0].id
    const row = async () => (await client.query('SELECT * FROM os_scheduled_tasks WHERE id = $1', [taskId])).rows[0]
    const setOwner = async (tab) => client.query('UPDATE os_scheduled_tasks SET dispatched_tab_id = $2 WHERE id = $1', [taskId, tab])

    // ── A. POSITIVE. Runs FIRST, on purpose. ────────────────────────────────
    console.log('\nA. POSITIVE: the owning tab can write every signal')
    await setOwner(OWNER_TAB)
    const a1 = await taskSignals.recordBound({ task_id: taskId, tab_id: OWNER_TAB })
    ok(!!(a1 && a1.ok), 'A1. bound from the owning tab returns ok')
    let r = await row()
    ok(!!r.bound_at, 'A2. bound_at is stamped on the row')
    ok(r.bound_tab_id === OWNER_TAB, 'A3. bound_tab_id records which tab bound')

    const a4 = await taskSignals.recordProgress({ task_id: taskId, tab_id: OWNER_TAB, summary: 'halfway' })
    ok(!!(a4 && a4.ok), 'A4. progress from the owning tab returns ok')
    r = await row()
    ok(r.progress_summary === 'halfway' && !!r.progress_at, 'A5. progress lands on the row')

    const a6 = await taskSignals.recordDone({
      task_id: taskId, tab_id: OWNER_TAB, status: 'success',
      result_summary: 'the probe returned 200', result_pointer: 'file:///proof',
    })
    ok(!!(a6 && a6.ok), 'A6. done from the owning tab returns ok')
    r = await row()
    ok(!!r.done_at, 'A7. done_at is stamped')
    ok(r.done_status === 'success', 'A8. done_status persists (dropping it made 48 of 48 rows look failed in June)')
    ok(r.done_summary === 'the probe returned 200', 'A9. done_summary persists')
    ok(r.done_pointer === 'file:///proof', 'A10. done_pointer persists')

    // ── B. THE GUARD, and every leg asserts the ABSENCE of the write ─────────
    console.log('\nB. NEGATIVE: a tab that does not own the row cannot write, and nothing lands')
    await client.query(
      `UPDATE os_scheduled_tasks SET bound_at = NULL, bound_tab_id = NULL, done_at = NULL,
        done_status = NULL, done_summary = NULL, done_pointer = NULL,
        progress_at = NULL, progress_summary = NULL WHERE id = $1`, [taskId])

    const b1 = await taskSignals.recordBound({ task_id: taskId, tab_id: OTHER_TAB })
    ok(!(b1 && b1.ok), 'B1. bound from a non-owning tab is REFUSED')
    ok(!!(b1 && b1.error), 'B2. the refusal carries a named error')
    r = await row()
    ok(r.bound_at === null, 'B3. ABSENCE: bound_at is still NULL (a refusal that writes anyway fails HERE, not above)')
    ok(r.bound_tab_id === null, 'B4. ABSENCE: bound_tab_id is still NULL')

    const b5 = await taskSignals.recordDone({ task_id: taskId, tab_id: OTHER_TAB, status: 'success', result_summary: 'not mine' })
    ok(!(b5 && b5.ok), 'B5. done from a non-owning tab is REFUSED')
    r = await row()
    ok(r.done_at === null && r.done_status === null && r.done_summary === null,
      'B6. ABSENCE: no part of the done landed')

    const b7 = await taskSignals.recordProgress({ task_id: taskId, tab_id: OTHER_TAB, summary: 'not mine either' })
    ok(!(b7 && b7.ok), 'B7. progress from a non-owning tab is REFUSED')
    r = await row()
    ok(r.progress_at === null && r.progress_summary === null, 'B8. ABSENCE: no progress landed')

    const b9 = await taskSignals.recordBound({ task_id: taskId, tab_id: null })
    ok(!(b9 && b9.ok), 'B9. a caller with no tab identity is REFUSED (cannot prove ownership)')
    const b10 = await taskSignals.recordBound({ task_id: 'not-a-uuid', tab_id: OWNER_TAB })
    ok(!(b10 && b10.ok) && /uuid/i.test(String(b10 && b10.error)),
      'B10. a non-uuid task_id is refused by name, not by a Postgres 22P02 out of the MCP surface')

    // POSITIVE CONTROL for section B. Without it a sink that refused everything
    // passes B1 through B10 perfectly.
    const b11 = await taskSignals.recordBound({ task_id: taskId, tab_id: OWNER_TAB })
    ok(!!(b11 && b11.ok), 'B11. POSITIVE CONTROL: the owning tab still succeeds after all those refusals')

    // ── C. THE CLEAR. A stale signal must not survive into the next dispatch ──
    console.log('\nC. the dispatch claim blanks the slate and stamps this dispatch')
    await client.query(
      `UPDATE os_scheduled_tasks SET status='dispatching', leased_by='lease-c', run_count=0,
        bound_at=NOW(), bound_tab_id='tab_previous_fire', done_at=NOW(), done_status='success',
        done_summary='a PRIOR fire finished', done_pointer='file:///old',
        progress_at=NOW(), progress_summary='old progress', dispatched_tab_id='tab_previous_fire'
       WHERE id=$1`, [taskId])
    const before = await row()
    ok(!!before.done_at && !!before.bound_at, 'C1. PRECONDITION: the row carries a full set of prior-fire signals')

    const cRes = await client.query(UPD_CLAIM, ['tab_this_fire', taskId, 'lease-c'])
    ok(cRes.rowCount === 1, 'C2. the claim matches the row it owns the lease on')
    r = await row()
    ok(r.dispatched_tab_id === 'tab_this_fire', 'C3. dispatched_tab_id now names THIS dispatch')
    const notCleared = LIFECYCLE.filter(c => r[c] !== null)
    ok(notCleared.length === 0, 'C4. every lifecycle column is NULL' + (notCleared.length ? ' (left set: ' + notCleared.join(',') + ')' : ''))

    // C5 is the leg that separates a working guard from one that fires on
    // everything: the claim must NOT match when the lease has been reclaimed.
    const cBad = await client.query(UPD_CLAIM, ['tab_thief', taskId, 'a-different-lease'])
    ok(cBad.rowCount === 0, 'C5. NEGATIVE: the claim does not match when the lease was reclaimed')
    r = await row()
    ok(r.dispatched_tab_id === 'tab_this_fire', 'C6. ABSENCE: the thief did not overwrite the tab id')

    // C7: the prior fire's worker is now locked out, which is the point of C.
    const c7 = await taskSignals.recordDone({ task_id: taskId, tab_id: 'tab_previous_fire', status: 'success', result_summary: 'late' })
    ok(!(c7 && c7.ok), 'C7. the PREVIOUS fire worker can no longer complete this row')
    r = await row()
    ok(r.done_at === null, 'C8. ABSENCE: the late done did not land')

    // ── D. THE LAUNCH LOCK, BOTH DIRECTIONS, through the real dispatchOne ────
    console.log('\nD. dispatchOne: the lock releases on a real bind, and does NOT on a foreign one')
    const origPick = creds.pick_healthiest_account
    const origRotate = creds.rotate_to
    const origCurrent = creds.current_account
    creds.pick_healthiest_account = async () => 'code'
    creds.rotate_to = async () => ({ deferred: true })
    creds.current_account = () => 'code'
    scheduler._setWorktreeFns({ allocate: async () => null, prune: async () => {} })

    async function runDispatch(tabId, binder) {
      await client.query(
        `UPDATE os_scheduled_tasks SET status='dispatching', leased_by='lease-d', run_count=0,
          dispatched_tab_id=NULL, bound_at=NULL, bound_tab_id=NULL, done_at=NULL, done_status=NULL,
          done_summary=NULL, done_pointer=NULL, progress_at=NULL, progress_summary=NULL,
          leased_at=NOW() WHERE id=$1`, [taskId])
      const fresh = await row()
      scheduler._setDispatcher({
        dispatch_worker: async () => {
          // The worker "comes up" here. binder runs on a timer so it lands DURING
          // the wait, which is the only way to observe a release rather than a
          // column that was already set before the loop started.
          if (binder) setTimeout(() => { binder().catch(() => {}) }, 300)
          return { ok: true, tab_id: tabId }
        },
        kill_worker: async () => ({ closed: false }),
      })
      // MEASURE THE WAIT, NOT THE CALL. dispatchOne completes a fast worker
      // INLINE, so on D9 markComplete runs inside the same call and its cost
      // lands in any end-to-end timing. Measured 2026-08-29: that inflated D9 to
      // 16645ms against a 6000ms budget on a contended pooler and reported a
      // working handshake as broken - the invented-failure shape this lane
      // already has doctrine for. Stamping the moment markComplete is entered
      // separates the two: waitMs is the lock, the remainder is the completion.
      const origMarkComplete = scheduler.markComplete
      let tMark = null
      scheduler.markComplete = async function (...a) { if (tMark === null) tMark = Date.now(); return origMarkComplete.apply(this, a) }
      const t0 = Date.now()
      try {
        await scheduler.dispatchOne(Object.assign({}, fresh, { leased_by: 'lease-d' }))
      } finally {
        scheduler.markComplete = origMarkComplete
      }
      const total = Date.now() - t0
      return { total, waitMs: tMark === null ? total : tMark - t0 }
    }

    const BUDGET = parseInt(process.env.SCHEDULER_SIGNAL_BOUND_TIMEOUT_MS, 10)

    // D1: a legitimate bind. The lock must RELEASE well inside the budget.
    const d1 = await runDispatch('tab_d1', () => coord.signal_bound({ task_id: taskId }, { tab_id: 'tab_d1' }))
    const d1ms = d1.waitMs
    r = await row()
    ok(d1ms < BUDGET, 'D1. RELEASES: a bind from the dispatched tab ends the wait early (' + d1ms + 'ms of ' + BUDGET + 'ms)')
    ok(!!r.bound_at, 'D2. the bind actually landed on the row')
    ok(r.status === 'running', 'D3. the row reached status=running')
    ok(r.dispatched_tab_id === 'tab_d1', 'D4. the row names the tab that was spawned')

    // D5: NO bind at all. The lock must NOT release: the wait runs its budget.
    // This is the direction a one-sided gate cannot see. Without it, a lock that
    // never engages at all scores identically to a working handshake.
    const d5ms = (await runDispatch('tab_d5', null)).waitMs
    r = await row()
    ok(d5ms >= BUDGET, 'D5. DOES NOT RELEASE: with no bind the wait runs its full budget (' + d5ms + 'ms of ' + BUDGET + 'ms)')
    ok(r.bound_at === null, 'D6. ABSENCE: bound_at stayed NULL through the whole wait')

    // D7: a bind from the WRONG tab, arriving during the wait. This separates
    // "the handshake works" from "the guard works". An unguarded sink releases
    // the lock here, and every other leg in this gate would still be green.
    const d7ms = (await runDispatch('tab_d7', () => coord.signal_bound({ task_id: taskId }, { tab_id: 'tab_an_impostor' }))).waitMs
    r = await row()
    ok(d7ms >= BUDGET, 'D7. DOES NOT RELEASE on a bind from a tab that does not own the row (' + d7ms + 'ms of ' + BUDGET + 'ms)')
    ok(r.bound_at === null, 'D8. ABSENCE: the impostor bind did not stamp the row')

    // D9: the fast worker. A done that arrives without a bound must still end the
    // wait AND complete the row inline. Losing this case rotted rows at running
    // until the 6h orphan sweep through all of July.
    const d9 = await runDispatch('tab_d9', () => coord.signal_done(
      { task_id: taskId, status: 'success', result_summary: 'finished before binding' },
      { tab_id: 'tab_d9' }))
    const d9ms = d9.waitMs
    r = await row()
    ok(d9ms < BUDGET, 'D9. a done without a bound ends the wait early (' + d9ms + 'ms of ' + BUDGET + 'ms)')
    ok(r.status === 'completed', 'D10. and the row is completed inline, not left running for the orphan sweep')

    creds.pick_healthiest_account = origPick
    creds.rotate_to = origRotate
    creds.current_account = origCurrent
    scheduler._resetWorktreeFns()

    // ── E. completionPass detects on the column, and only on the column ──────
    console.log('\nE. completionPass completes a row carrying done_at, and leaves one without')
    await client.query(
      `UPDATE os_scheduled_tasks SET status='running', leased_at=NOW(), leased_by='lease-e',
        dispatched_tab_id='tab_e', done_at=NULL, done_status=NULL, done_summary=NULL WHERE id=$1`, [taskId])
    scheduler._setDispatcher({ kill_worker: async () => ({ closed: false }) })
    scheduler._setWorktreeFns({ allocate: async () => null, prune: async () => {} })
    await scheduler.completionPass()
    r = await row()
    ok(r.status === 'running', 'E1. NEGATIVE: a running row with no done_at is left alone')

    await taskSignals.recordDone({ task_id: taskId, tab_id: 'tab_e', status: 'success', result_summary: 'e done' })
    await scheduler.completionPass()
    r = await row()
    ok(r.status === 'completed', 'E2. POSITIVE: once done_at is set the same row completes')
    ok(String(r.last_result || '').indexOf('e done') !== -1, 'E3. the summary reaches last_result')
    scheduler._resetWorktreeFns()

    // ── G. the signal is CONSUMED at the terminal transition ────────────────
    //
    // completionPass selects `status='running' AND done_at IS NOT NULL` and its
    // comment asserts nothing else can have written it. That is true of the WRITE
    // path and was false of the ROW: the only thing that ever cleared these
    // columns was dispatchOne's step 3b, and the ADOPT path (step 2d, the
    // 2026-07-17 double-spawn guard) flips a row to running and RETURNS before
    // reaching it. A consumed done therefore survived to complete a second time.
    //
    // BOTH DIRECTIONS ARE GATED HERE, because a fix that simply blanked the
    // columns at adopt would pass the phantom legs and silently LOSE a legitimate
    // completion (staleLeaseRecovery branch 1 reclaims a lease without touching
    // dispatched_tab_id, so a reclaimed worker's done still lands while the row
    // sits active). G7 is that control: it must still complete.
    console.log('\nG. a completion is consumed at the terminal transition, and only then')
    const gIns = await client.query(
      `INSERT INTO os_scheduled_tasks (name, type, prompt, status, next_run_at, run_count, cron_expression, tz)
       VALUES ($1, 'cron', 'task-signal-gate adopt probe', 'active', $2, 0, '0 3 * * *', 'Australia/Brisbane')
       RETURNING id`,
      [LANE + '-adopt-probe', FAR_FUTURE]
    )
    const gId = gIns.rows[0].id
    const gRow = async () => (await client.query('SELECT * FROM os_scheduled_tasks WHERE id = $1', [gId])).rows[0]
    const gKilled = []
    scheduler._setDispatcher({ kill_worker: async (a) => { gKilled.push(a && a.tab_id); return { closed: false } } })
    scheduler._setWorktreeFns({ allocate: async () => null, prune: async () => {} })

    // first fire: a normal, legitimate completion
    await client.query(
      `UPDATE os_scheduled_tasks SET status='running', leased_at=NOW(),
         leased_by='lease-g', dispatched_tab_id='tab_g1' WHERE id=$1`, [gId])
    await taskSignals.recordDone({ task_id: gId, tab_id: 'tab_g1', status: 'success', result_summary: 'g first fire' })
    await scheduler.completionPass()
    let g = await gRow()
    ok(g.status === 'active' && g.run_count === 1,
      'G1. POSITIVE: the first fire completes normally (status=' + g.status + ' run_count=' + g.run_count + ')')
    ok(g.done_at === null,
      'G2. ABSENCE: the terminal transition consumed done_at')
    ok(g.done_status === null && g.done_summary === null && g.done_pointer === null,
      'G3. ABSENCE: it consumed done_status/summary/pointer with it')

    // the ADOPT path, driven through dispatchOne's OWN shipped statement rather
    // than a hand-copy. Its guard is (status='dispatching' AND leased_by match),
    // so put the row where the real 2d branch finds it first.
    ok(!!UPD_ADOPT, 'G3b. the adopt statement was found in dispatchOne\'s shipped source')
    await client.query(
      `UPDATE os_scheduled_tasks SET status='dispatching', leased_by='lease-g-adopt' WHERE id=$1`, [gId])
    await client.query(UPD_ADOPT, ['tab_g2_live', gId, 'lease-g-adopt'])
    await client.query(
      `UPDATE os_scheduled_tasks SET leased_at=NOW() WHERE id=$1 AND leased_at IS NULL`, [gId])
    const gBefore = (await gRow()).run_count
    gKilled.length = 0
    await scheduler.completionPass()
    g = await gRow()
    ok(g.run_count === gBefore,
      'G4. NEGATIVE: an adopted row does not re-complete off the prior fire (run_count ' + gBefore + ' -> ' + g.run_count + ')')
    ok(gKilled.indexOf('tab_g2_live') === -1,
      'G5. ABSENCE: the live worker the row just adopted was not killed (killed=' + JSON.stringify(gKilled) + ')')
    ok(g.status === 'running',
      'G6. the adopted row is still running, not falsely advanced (status=' + g.status + ')')

    // THE CONTROL. An overcorrected fix that cleared at adopt would pass G4-G6
    // and lose this. The adopted worker's OWN done must still complete the row.
    await taskSignals.recordDone({ task_id: gId, tab_id: 'tab_g2_live', status: 'success', result_summary: 'g adopted fire' })
    await scheduler.completionPass()
    g = await gRow()
    ok(g.run_count === gBefore + 1,
      'G7. CONTROL: the adopted worker\'s OWN done still completes the row (run_count ' + gBefore + ' -> ' + g.run_count + ')')
    ok(String(g.last_result || '').indexOf('g adopted fire') !== -1,
      'G8. CONTROL: and it is THAT done that landed, not the consumed one')

    // markFailed is the other terminal transition and needs the same consume, or
    // a failed row carries its signal into the next adopt exactly the same way.
    await client.query(
      `UPDATE os_scheduled_tasks SET status='running', leased_at=NOW(),
         leased_by='lease-g', dispatched_tab_id='tab_g3', retry_count=0 WHERE id=$1`, [gId])
    await taskSignals.recordDone({ task_id: gId, tab_id: 'tab_g3', status: 'failed', result_summary: 'g failed fire' })
    await scheduler.completionPass()
    g = await gRow()
    ok(g.done_at === null && g.done_status === null,
      'G9. ABSENCE: markFailed consumes the signal too (done_at=' + g.done_at + ' done_status=' + g.done_status + ')')
    scheduler._resetWorktreeFns()

    // ── F. the retired bus types are genuinely gone, not renamed ─────────────
    console.log('\nF. the retired message types are not produced anywhere')
    ok(typeof coord.scanTopicByType !== 'function',
      'F1. coord.scanTopicByType is no longer exported (the scheduler is not a bus reader)')
    ok(!/coord\.(peek_inbox|read_inbox|ack_message|scanTopicByType)/.test(SRC),
      'F2. dispatchOne contains no coord inbox call at all')
    ok(!/scanTopicByType/.test(scheduler.completionPass.toString()),
      'F3. completionPass contains no scanTopicByType call')

    console.log('\n' + pass + ' passed, ' + fail + ' failed')
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
    process.exit(fail > 0 ? 1 : 0)
  } catch (e) {
    // Exit 2, never 1. A crash and a failed leg are both a non-zero exit with
    // something on stderr, and that confusion scored a broken helper green on
    // this same lane on 2026-08-28.
    console.error('\nGATE CRASHED: ' + (e && e.stack || e))
    try { await client.query('ROLLBACK') } catch (_e) {}
    try { client.release() } catch (_e) {}
    try { await pool.end() } catch (_e) {}
    process.exit(2)
  }
}

main()
