// scheduler.test.js - tests for the Phase 3 autonomy substrate scheduler.
//
// Run with: node tools/scheduler.test.js
// Exit 0 = all pass.
//
// Tests run sequentially (chained via .then) to avoid async ordering issues
// from concurrent state mutation of creds/coord module exports.

'use strict'

let passed = 0
let failed = 0
const tests = []  // array of { name, fn } - run sequentially

function assert(condition, label) {
  if (condition) {
    console.log('  PASS:', label)
    passed++
  } else {
    console.error('  FAIL:', label)
    failed++
  }
}

function test(name, fn) {
  tests.push({ name, fn })
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides) {
  return Object.assign({
    id: 'task-123',
    name: 'morning-briefing',
    type: 'cron',
    status: 'active',
    cron_expression: '0 9 * * *',
    prompt: 'Run the morning briefing.',
    preferred_account: 'tate',
    actual_account: null,
    retry_count: 0,
    dispatched_tab_id: null,
  }, overrides)
}

function makeStubPool(rowsForSelect) {
  const queries = []
  const pool = {
    _queries: queries,
    query(sql, params) {
      queries.push({ sql, params: params || [] })
      if (sql.trim().toUpperCase().startsWith('SELECT') || sql.includes('RETURNING')) {
        return Promise.resolve({ rows: rowsForSelect || [], rowCount: (rowsForSelect || []).length })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
  }
  return pool
}

// ── import scheduler ──────────────────────────────────────────────────────────

const scheduler = require('./scheduler')
const credsModule = require('./creds')
const coordModule = require('./coord')

// ── Task 3.1: buildBrief ──────────────────────────────────────────────────────

test('buildBrief: signal_bound instruction with task_id appears first', async () => {
  const row = makeRow({ id: 'abc-def-123' })
  const brief = scheduler.buildBrief(row)
  assert(
    brief.includes('coord.signal_bound now with { task_id: "abc-def-123"'),
    'buildBrief: signal_bound instruction present with correct task_id'
  )
  assert(
    brief.indexOf('signal_bound') < brief.indexOf(row.prompt),
    'buildBrief: signal_bound appears before row.prompt'
  )
})

test('buildBrief: row.prompt appears verbatim', async () => {
  const prompt = 'Do something important with special chars: & < > "quotes".'
  const row = makeRow({ prompt })
  const brief = scheduler.buildBrief(row)
  assert(brief.includes(prompt), 'buildBrief: row.prompt in brief verbatim')
})

test('buildBrief: signal_done section present with task_id', async () => {
  const row = makeRow({ id: 'xyz-789' })
  const brief = scheduler.buildBrief(row)
  assert(brief.includes('signal_done'), 'buildBrief: signal_done instructions present')
  assert(
    brief.includes('task_id: "xyz-789"'),
    'buildBrief: signal_done references correct task_id'
  )
})

test('buildBrief: actual_account appears in brief when set', async () => {
  const row = makeRow({ id: 'acct-test', actual_account: 'code' })
  const brief = scheduler.buildBrief(row)
  assert(brief.includes('code'), 'buildBrief: actual_account in brief')
})

// ── 2026-06-10 branch-thrash guard: buildBrief worktree directive ───────────

test('buildBrief: worktree_path injects WORKTREE block at top + shared-tree warning', async () => {
  const row = makeRow({
    id: 'wt-test-1',
    worktree_path: '/Users/ecodia/.code/ecodiaos/_worktrees/dispatched/wt-test-1',
  })
  const brief = scheduler.buildBrief(row)
  assert(brief.includes('WORKTREE: /Users/ecodia/.code/ecodiaos/_worktrees/dispatched/wt-test-1'),
    'buildBrief: WORKTREE: header present with full path')
  assert(brief.includes('git -C /Users/ecodia/.code/ecodiaos/_worktrees/dispatched/wt-test-1'),
    'buildBrief: git -C <worktree> directive present')
  assert(brief.includes('Do NOT operate on /Users/ecodia/.code/ecodiaos/backend'),
    'buildBrief: shared-tree warning present')
  assert(brief.indexOf('WORKTREE:') < brief.indexOf('FIRST ACTION'),
    'buildBrief: WORKTREE block appears BEFORE FIRST ACTION (worker sees it first)')
})

test('buildBrief: omits WORKTREE block when worktree_path is unset', async () => {
  const row = makeRow({ id: 'no-wt-test' })
  const brief = scheduler.buildBrief(row)
  assert(!brief.includes('WORKTREE:'),
    'buildBrief: no WORKTREE block when worktree_path is null/undefined (back-compat)')
  // Without a worktree path the brief still functions: signal_bound + TASK + signal_done.
  assert(brief.includes('signal_bound'), 'buildBrief: signal_bound still present in legacy mode')
  assert(brief.includes('signal_done'), 'buildBrief: signal_done still present in legacy mode')
})

// ── Task 3.1: launchLock ──────────────────────────────────────────────────────

test('launchLock: serializes 2 concurrent acquires in order', async () => {
  const lock = scheduler._launchLock
  const order = []

  const r1 = await lock.acquire()
  order.push('acquired-1')

  let r2Acquired = false
  const p2 = lock.acquire().then(r => {
    order.push('acquired-2')
    r2Acquired = true
    return r
  })

  assert(!r2Acquired, 'launchLock: lock-2 not acquired while lock-1 held')
  r1()  // release lock-1

  const r2 = await p2
  assert(r2Acquired, 'launchLock: lock-2 acquired after lock-1 released')
  assert(order[0] === 'acquired-1' && order[1] === 'acquired-2', 'launchLock: in-order release/acquire')
  r2()  // release lock-2
})

// ── Task 3.2: leaseDueRows SQL shape ─────────────────────────────────────────

test('leaseDueRows: SQL contains FOR UPDATE SKIP LOCKED and limit param', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)

  await scheduler.leaseDueRows(3)

  const q = pool._queries[0]
  assert(q && q.sql.includes('FOR UPDATE SKIP LOCKED'), 'leaseDueRows: FOR UPDATE SKIP LOCKED in SQL')
  assert(q && q.params.indexOf(3) !== -1, 'leaseDueRows: limit param (3) passed')
  assert(q && q.sql.toLowerCase().includes("status = 'active'"), 'leaseDueRows: filters status=active')
})

// ── Task 3.2: dispatchOne happy path ─────────────────────────────────────────

// 2026-06-10 branch-thrash guard: stub worktree fns so dispatchOne tests do not
// touch the real shared tree's git state. Tests that exercise the allocator
// path explicitly override with their own capture stubs.
function stubNoopWorktreeFns() {
  scheduler._setWorktreeFns({
    allocate: async () => '/tmp/test-worktree',
    prune: async () => {},
  })
}

test('dispatchOne happy path: rotates creds, calls dispatcher, row -> running', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)
  stubNoopWorktreeFns()

  // Stub creds module exports in-place (same cached object scheduler uses).
  const origPick = credsModule.pick_healthiest_account
  const origRotate = credsModule.rotate_to
  let pickedAccount = null
  let rotatedTo = null
  credsModule.pick_healthiest_account = async () => { pickedAccount = 'code'; return 'code' }
  credsModule.rotate_to = async (acct) => { rotatedTo = acct; return { previous: 'tate', current: acct } }

  // Stub dispatcher.
  let dispatched = null
  scheduler._setDispatcher({
    dispatch_worker: async (params) => {
      dispatched = params
      return { ok: true, tab_id: 'tab_test_abc', task_id: params.task_id }
    },
    kill_worker: async () => {}
  })

  // Stub coord.peek_inbox to return a bound signal immediately.
  const origPeekInbox = coordModule.peek_inbox
  const origReadInbox = coordModule.read_inbox
  coordModule.peek_inbox = async () => ({
    messages: [{ body: { type: 'bound', task_id: 'task-dispatch-happy' } }]
  })
  coordModule.read_inbox = async () => ({ messages: [] })

  const row = makeRow({ id: 'task-dispatch-happy', preferred_account: 'code' })

  let threw = false
  try {
    await scheduler.dispatchOne(row)
  } catch (e) {
    threw = true
    console.error('  [dispatchOne happy path threw]:', e.message)
  }

  assert(!threw, 'dispatchOne happy path: no throw')
  assert(pickedAccount === 'code', 'dispatchOne: pick_healthiest_account called, got code')
  assert(rotatedTo === 'code', 'dispatchOne: rotate_to called with code')
  assert(dispatched !== null, 'dispatchOne: dispatch_worker called')
  assert(dispatched && dispatched.ide === 'stable', 'dispatchOne: ide=stable passed')

  const runningUpdate = pool._queries.find(q => q.sql.includes("status = 'running'"))
  assert(!!runningUpdate, 'dispatchOne: row updated to status=running')
  assert(
    runningUpdate && runningUpdate.params.includes('code'),
    'dispatchOne: actual_account=code in UPDATE params'
  )

  // Restore.
  credsModule.pick_healthiest_account = origPick
  credsModule.rotate_to = origRotate
  coordModule.peek_inbox = origPeekInbox
  coordModule.read_inbox = origReadInbox
})

// ── 2026-06-19 defense-in-depth austerity gate inside dispatchOne ───────────
// leaseDueRows excludes austerity_paused rows, but an incident showed paused
// crons reaching dispatchOne in a burst and spawning worker tabs anyway. The
// dispatchOne re-read must SKIP a now-paused row: no dispatch_worker, lease
// released without a retry (no markFailed, next_run_at untouched).
test('dispatchOne: SKIPs an austerity_paused row - no dispatch, lease released, no retry', async () => {
  // Stub pool returns the guard SELECT row as paused.
  const pool = makeStubPool([{
    austerity_paused: true, status: 'dispatching', archived_at: null,
    last_status: null, name: 'calendar-watch',
  }])
  scheduler._setPool(pool)
  stubNoopWorktreeFns()

  const origPick = credsModule.pick_healthiest_account
  const origRotate = credsModule.rotate_to
  let pickCalled = false
  credsModule.pick_healthiest_account = async () => { pickCalled = true; return 'code' }
  credsModule.rotate_to = async () => ({ previous: 'tate', current: 'code' })

  let dispatched = false
  scheduler._setDispatcher({
    dispatch_worker: async () => { dispatched = true; return { ok: true, tab_id: 'should_not_spawn' } },
    kill_worker: async () => {},
  })

  const row = makeRow({ id: 'paused-cron-guard', name: 'calendar-watch', leased_by: 'lease-x' })

  let threw = false
  try { await scheduler.dispatchOne(row) } catch (e) { threw = true; console.error('  [guard test threw]:', e.message) }

  assert(!threw, 'guard: no throw')
  assert(dispatched === false, 'guard: dispatch_worker NOT called for paused row')
  assert(pickCalled === false, 'guard: cred rotation skipped (guard fires before step 1)')

  const releaseUpdate = pool._queries.find(q =>
    q.sql.includes("status = 'active'") && q.sql.includes('leased_by = NULL') && q.sql.includes('dispatching'))
  assert(!!releaseUpdate, 'guard: lease released back to active')
  const runningUpdate = pool._queries.find(q => q.sql.includes("status = 'running'"))
  assert(!runningUpdate, 'guard: row NOT flipped to running')
  // No markFailed (would set retry_count / status=failed or defer next_run_at).
  const failedUpdate = pool._queries.find(q => q.sql.includes("status = 'failed'") || q.sql.includes('retry_count ='))
  assert(!failedUpdate, 'guard: markFailed NOT invoked (suppression, not failure)')

  credsModule.pick_healthiest_account = origPick
  credsModule.rotate_to = origRotate
})

// ── 2026-06-10 branch-thrash guard: dispatchOne worktree wiring + cleanup ───

test('dispatchOne: allocates worktree, passes path into brief, dispatches with worker_acknowledgment_timeout_ms=0', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)

  let allocateCalledWith = null
  let pruneCalledWith = null
  scheduler._setWorktreeFns({
    allocate: async (row) => {
      allocateCalledWith = row
      return '/tmp/test/wt-' + row.id
    },
    prune: async (row) => { pruneCalledWith = row },
  })

  const origPick = credsModule.pick_healthiest_account
  const origRotate = credsModule.rotate_to
  credsModule.pick_healthiest_account = async () => 'tate'
  credsModule.rotate_to = async () => ({ previous: 'tate', current: 'tate' })

  let dispatched = null
  scheduler._setDispatcher({
    dispatch_worker: async (params) => {
      dispatched = params
      return { ok: true, tab_id: 'tab_wt_test', task_id: params.task_id }
    },
    kill_worker: async () => {},
  })

  const origPeekInbox = coordModule.peek_inbox
  const origReadInbox = coordModule.read_inbox
  coordModule.peek_inbox = async () => ({
    messages: [{ body: { type: 'bound', task_id: 'wt-alloc-test' } }]
  })
  coordModule.read_inbox = async () => ({ messages: [] })

  const row = makeRow({ id: 'wt-alloc-test' })
  await scheduler.dispatchOne(row)

  assert(allocateCalledWith && allocateCalledWith.id === 'wt-alloc-test',
    'dispatchOne: allocateWorktreeForRow called with the row')
  assert(dispatched && dispatched.brief && dispatched.brief.includes('WORKTREE: /tmp/test/wt-wt-alloc-test'),
    'dispatchOne: brief contains the allocated WORKTREE path')
  // markComplete owns prune, not dispatchOne happy-path - so prune should NOT have fired yet.
  assert(pruneCalledWith === null, 'dispatchOne happy path: prune NOT called (markComplete owns it)')

  credsModule.pick_healthiest_account = origPick
  credsModule.rotate_to = origRotate
  coordModule.peek_inbox = origPeekInbox
  coordModule.read_inbox = origReadInbox
  scheduler._resetWorktreeFns()
})

test('dispatchOne: tolerates worktree allocate failure (proceeds without isolated tree, logs)', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)

  scheduler._setWorktreeFns({
    allocate: async () => { throw new Error('synthetic git worktree add failure') },
    prune: async () => {},
  })

  const origPick = credsModule.pick_healthiest_account
  const origRotate = credsModule.rotate_to
  credsModule.pick_healthiest_account = async () => 'tate'
  credsModule.rotate_to = async () => ({ previous: 'tate', current: 'tate' })

  let dispatched = null
  scheduler._setDispatcher({
    dispatch_worker: async (params) => {
      dispatched = params
      return { ok: true, tab_id: 'tab_wt_fail', task_id: params.task_id }
    },
    kill_worker: async () => {},
  })

  const origPeekInbox = coordModule.peek_inbox
  const origReadInbox = coordModule.read_inbox
  coordModule.peek_inbox = async () => ({
    messages: [{ body: { type: 'bound', task_id: 'wt-fail-test' } }]
  })
  coordModule.read_inbox = async () => ({ messages: [] })

  const row = makeRow({ id: 'wt-fail-test' })
  let threw = false
  try { await scheduler.dispatchOne(row) } catch (e) { threw = true }
  assert(!threw, 'dispatchOne: allocate failure does NOT crash the dispatch')
  assert(dispatched !== null, 'dispatchOne: dispatched anyway, hook is the runtime backstop')
  assert(dispatched && dispatched.brief && !dispatched.brief.includes('WORKTREE:'),
    'dispatchOne: brief omits WORKTREE block when allocate failed')

  credsModule.pick_healthiest_account = origPick
  credsModule.rotate_to = origRotate
  coordModule.peek_inbox = origPeekInbox
  coordModule.read_inbox = origReadInbox
  scheduler._resetWorktreeFns()
})

test('markComplete: calls pruneWorktreeForRow', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)

  let pruneCalledWith = null
  scheduler._setWorktreeFns({
    allocate: async () => '/tmp/x',
    prune: async (row) => { pruneCalledWith = row },
  })

  scheduler._setDispatcher({
    dispatch_worker: async () => ({ ok: true }),
    kill_worker: async () => ({ closed: true }),
  })

  const row = makeRow({
    id: 'mc-prune-test',
    type: 'cron',
    cron_expression: '0 9 * * *',
    dispatched_tab_id: 'tab_x',
  })
  await scheduler.markComplete(row, { type: 'done', task_id: 'mc-prune-test', status: 'success' })

  assert(pruneCalledWith && pruneCalledWith.id === 'mc-prune-test',
    'markComplete: pruneWorktreeForRow called with the row')

  scheduler._resetWorktreeFns()
})

// ── Task 3.2: dispatchOne AllAccountsCappedError defers ──────────────────────

test('dispatchOne AllAccountsCappedError: defers row, does not mark failed', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)
  stubNoopWorktreeFns()

  const origPick = credsModule.pick_healthiest_account
  const { AllAccountsCappedError } = credsModule
  credsModule.pick_healthiest_account = async () => {
    throw new AllAccountsCappedError({ tate: null, code: null, money: null })
  }

  // Ensure dispatcher is set (non-null) to avoid null deref before creds throws.
  scheduler._setDispatcher({ dispatch_worker: async () => ({}), kill_worker: async () => {} })

  const row = makeRow({ id: 'task-capped-test' })
  let threw = false
  try {
    await scheduler.dispatchOne(row)
  } catch (e) {
    threw = true
  }

  const deferUpdate = pool._queries.find(q =>
    q.sql.includes("status = 'active'") && q.sql.includes('next_run_at')
  )
  assert(!!deferUpdate, 'dispatchOne AllCapped: row deferred (status=active, next_run_at set)')
  assert(threw, 'dispatchOne AllCapped: re-throws AllAccountsCappedError')

  credsModule.pick_healthiest_account = origPick
})

// ── 2026-06-02 P0: dispatchOne "no IDE instances registered" defers ─────────

test('dispatchOne no-IDE error: defers row 5min, does not mark failed, does not touch retry_count', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)
  stubNoopWorktreeFns()

  const origPick = credsModule.pick_healthiest_account
  const origRotate = credsModule.rotate_to
  credsModule.pick_healthiest_account = async () => 'tate'
  credsModule.rotate_to = async () => ({ previous: 'tate', current: 'tate' })

  scheduler._setDispatcher({
    dispatch_worker: async () => ({
      ok: false,
      tab_id: null,
      error: 'populate failed (editor.open): no IDE instances registered. The ecodia-preview extension must be installed and the IDE running.'
    }),
    kill_worker: async () => {},
  })

  const row = makeRow({ id: 'task-no-ide-defer', retry_count: 2 })
  let threw = false
  try {
    await scheduler.dispatchOne(row)
  } catch (e) {
    threw = true
  }

  // Find the defer UPDATE (status=active + next_run_at + last_error mentioning IDE bridge).
  const deferUpdate = pool._queries.find(q =>
    q.sql.includes("status = 'active'") &&
    q.sql.includes('next_run_at') &&
    q.params.some(p => typeof p === 'string' && p.includes('no IDE bridge registered'))
  )
  assert(!!deferUpdate, 'dispatchOne no-IDE: defer UPDATE landed with next_run_at + IDE bridge marker')
  assert(threw, 'dispatchOne no-IDE: still re-throws so dispatch loop logs')

  // CRITICAL: retry_count must NOT be incremented (no $1 = retry_count in defer UPDATE).
  const markFailedUpdate = pool._queries.find(q =>
    q.sql.includes('retry_count = $1') && q.sql.includes("status = 'failed'")
  )
  assert(!markFailedUpdate, 'dispatchOne no-IDE: row was NOT marked failed (cron survives IDE gap)')

  credsModule.pick_healthiest_account = origPick
  credsModule.rotate_to = origRotate
})

// ── 2026-06-02 P0: markFailed cron at MAX_RETRY_COUNT defers to next interval ─

test('markFailed cron at MAX_RETRY_COUNT: defers to next cron interval, resets retry_count', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)

  const row = makeRow({
    id: 'task-cron-maxed',
    type: 'cron',
    cron_expression: '0 9 * * *',
    retry_count: 2,  // newRetryCount = 3 = MAX_RETRY_COUNT
  })
  await scheduler.markFailed(row, new Error('some transient failure'))

  const deferUpdate = pool._queries.find(q =>
    q.sql.includes("status = 'active'") &&
    q.sql.includes('retry_count = 0') &&
    q.sql.includes('next_run_at = $2')
  )
  assert(!!deferUpdate, 'markFailed cron-maxed: status=active, retry_count reset to 0, next_run_at set')

  // The other branch (status=failed) must NOT have fired.
  const failedUpdate = pool._queries.find(q =>
    q.sql.includes("status = 'failed'")
  )
  assert(!failedUpdate, 'markFailed cron-maxed: did NOT permanently fail the cron row')

  // next_run_at must be a valid future ISO.
  if (deferUpdate && deferUpdate.params[1]) {
    const nextRun = new Date(deferUpdate.params[1])
    assert(!isNaN(nextRun.getTime()), 'markFailed cron-maxed: next_run_at parses to valid date')
    assert(nextRun.getTime() > Date.now(), 'markFailed cron-maxed: next_run_at is in the future')
  } else {
    assert(false, 'markFailed cron-maxed: next_run_at param missing')
  }
})

// ── 2026-06-02 P0: markFailed non-cron at MAX_RETRY_COUNT still permanently fails

test('markFailed delayed at MAX_RETRY_COUNT: still marks failed (one-shot semantics preserved)', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)

  const row = makeRow({
    id: 'task-delayed-maxed',
    type: 'delayed',
    cron_expression: null,
    retry_count: 2,  // newRetryCount = 3 = MAX_RETRY_COUNT
  })
  await scheduler.markFailed(row, new Error('genuine permanent failure'))

  const failedUpdate = pool._queries.find(q =>
    q.sql.includes("status = 'failed'")
  )
  assert(!!failedUpdate, 'markFailed delayed-maxed: row marked failed (one-shot work IS done)')
})

// ── Task 3.2: launchLock released on dispatch_worker error ───────────────────

test('launchLock: released in finally even when dispatch_worker throws', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)

  const origPick = credsModule.pick_healthiest_account
  const origRotate = credsModule.rotate_to
  credsModule.pick_healthiest_account = async () => 'tate'
  credsModule.rotate_to = async () => ({ previous: 'tate', current: 'tate' })

  const origPeekInbox = coordModule.peek_inbox
  coordModule.peek_inbox = async () => ({ messages: [] })

  scheduler._setDispatcher({
    dispatch_worker: async () => { throw new Error('dispatch failed intentionally') },
    kill_worker: async () => {}
  })

  const row = makeRow({ id: 'task-lock-release-test' })
  let threw = false
  try {
    await scheduler.dispatchOne(row)
  } catch (e) {
    threw = true
  }

  assert(threw, 'launchLock finally: dispatchOne re-throws')

  // Lock must be released - must be acquirable immediately.
  let lockAcquired = false
  const lockP = scheduler._launchLock.acquire().then(release => {
    lockAcquired = true
    release()
  })
  // Give it a short time.
  await new Promise(r => setTimeout(r, 100))
  await lockP

  assert(lockAcquired, 'launchLock finally: lock released after error (acquirable in <100ms)')

  credsModule.pick_healthiest_account = origPick
  credsModule.rotate_to = origRotate
  coordModule.peek_inbox = origPeekInbox
})

// ── Task 3.3: markComplete cron reschedules ───────────────────────────────────

test('markComplete cron: computes next_run_at and sets status=active', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => {} })

  const row = makeRow({
    id: 'task-cron-done',
    type: 'cron',
    cron_expression: '0 9 * * *',
    dispatched_tab_id: null,
  })

  await scheduler.markComplete(row, { status: 'success', result_summary: 'done fine' })

  const activeUpdate = pool._queries.find(q =>
    q.sql.includes("status = 'active'") && q.sql.includes('next_run_at')
  )
  assert(!!activeUpdate, 'markComplete cron: UPDATE sets status=active with next_run_at')

  if (activeUpdate && activeUpdate.params[0]) {
    const nextRun = new Date(activeUpdate.params[0])
    assert(!isNaN(nextRun.getTime()), 'markComplete cron: next_run_at parses to valid date')
    assert(nextRun.getTime() > Date.now(), 'markComplete cron: next_run_at is in the future')
  } else {
    assert(false, 'markComplete cron: next_run_at param is not null')
  }
})

// ── Task 3.3: markComplete one_shot sets completed ───────────────────────────

test('markComplete one_shot: sets status=completed', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => {} })

  const row = makeRow({
    id: 'task-oneshot-done',
    type: 'one_shot',
    cron_expression: null,
    dispatched_tab_id: null,
  })

  await scheduler.markComplete(row, { status: 'success', result_summary: 'one_shot done' })

  const completedUpdate = pool._queries.find(q => q.sql.includes("status = 'completed'"))
  assert(!!completedUpdate, 'markComplete one_shot: status set to completed')
})

// ── 2026-06-18: completionPass scans seen+unseen, freshness-gated ─────────────
//
// Root-cause of the scheduler completion gap: completionPass used peek_inbox,
// which only returns UNSEEN messages. The interactive conductor drains the same
// chat.conductor.inbox via read_inbox and marks done signals seen within ~1s, so
// completionPass lost the race and rows rotted in status=running. The fix scans
// the full index (seen or unseen) via coord.scanTopicByType, gated on
// created_at >= leased_at so a prior cron fire's stale done cannot complete a
// fresh dispatch.

test('completionPass: fresh done (created_at >= leased_at) completes a running cron row', async () => {
  const leasedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()  // 1h ago
  const doneAt = new Date(Date.now() - 30 * 1000).toISOString()         // 30s ago (after lease)
  const runningRow = makeRow({
    id: 'task-comp-fresh',
    type: 'cron',
    cron_expression: '0 9 * * *',
    status: 'running',
    leased_at: leasedAt,
    dispatched_tab_id: null,
  })
  const pool = makeStubPool([runningRow])
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => ({ closed: true }) })
  scheduler._setWorktreeFns({ allocate: async () => null, prune: async () => {} })

  const origScan = coordModule.scanTopicByType
  coordModule.scanTopicByType = () => new Map([
    ['task-comp-fresh', { created_at: doneAt, body: { type: 'done', task_id: 'task-comp-fresh', status: 'success', result_summary: 'ok' } }],
  ])

  await scheduler.completionPass()

  const rescheduled = pool._queries.find(q =>
    q.sql.includes("status = 'active'") && q.sql.includes('next_run_at')
  )
  assert(!!rescheduled, 'completionPass fresh: running cron row rescheduled to active (loop closed)')

  coordModule.scanTopicByType = origScan
  scheduler._resetWorktreeFns()
})

test('completionPass: stale done (created_at < leased_at) does NOT complete (freshness gate)', async () => {
  const leasedAt = new Date(Date.now() - 60 * 1000).toISOString()        // leased 60s ago
  const staleDoneAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()  // 3h-old done from a prior fire
  const runningRow = makeRow({
    id: 'task-comp-stale',
    type: 'cron',
    cron_expression: '0 9 * * *',
    status: 'running',
    leased_at: leasedAt,
    dispatched_tab_id: null,
  })
  const pool = makeStubPool([runningRow])
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => ({ closed: true }) })
  scheduler._setWorktreeFns({ allocate: async () => null, prune: async () => {} })

  const origScan = coordModule.scanTopicByType
  coordModule.scanTopicByType = () => new Map([
    ['task-comp-stale', { created_at: staleDoneAt, body: { type: 'done', task_id: 'task-comp-stale', status: 'success' } }],
  ])

  await scheduler.completionPass()

  const rescheduled = pool._queries.find(q =>
    q.sql.includes("status = 'active'") && q.sql.includes('next_run_at')
  )
  assert(!rescheduled, 'completionPass stale: prior-fire done ignored, row left running for its own worker')

  coordModule.scanTopicByType = origScan
  scheduler._resetWorktreeFns()
})

// ── Task 3.3: staleLeaseRecovery SQL shapes ───────────────────────────────────
//
// 2026-06-10: shape changed after the per-row coord-liveness gate landed.
// Branch 2b (non-cron max-retry) converted from a bulk UPDATE to SELECT +
// per-row UPDATE so each row can be skipped if a live worker tab is still
// heartbeating. With empty stub rows, the new shape emits 4 queries
// (1 bulk UPDATE + 3 SELECTs), not 3.

test('staleLeaseRecovery: issues 4 SQL queries with correct shapes', async () => {
  const pool = makeStubPool([])
  scheduler._setPool(pool)
  scheduler._setCoord({ list_workers: async () => ({ count: 0, workers: [] }) })

  await scheduler.staleLeaseRecovery()

  assert(pool._queries.length === 4, 'staleLeaseRecovery: exactly 4 queries issued (got ' + pool._queries.length + ')')

  const retryable = pool._queries.find(q =>
    q.sql.includes("status = 'active'") &&
    q.sql.includes("status = 'dispatching'") &&
    q.sql.includes('retry_count + 1') &&
    q.sql.includes('< $2')
  )
  assert(!!retryable, 'staleLeaseRecovery: retryable stale-dispatch query correct shape')

  const cronStaleSelect = pool._queries.find(q =>
    q.sql.includes('SELECT') &&
    q.sql.includes("status = 'dispatching'") &&
    q.sql.includes('>= $2') &&
    q.sql.includes("type = 'cron'")
  )
  assert(!!cronStaleSelect, 'staleLeaseRecovery: cron stale-lease SELECT correct shape')

  const nonCronStaleSelect = pool._queries.find(q =>
    q.sql.includes('SELECT') &&
    q.sql.includes("status = 'dispatching'") &&
    q.sql.includes('>= $2') &&
    q.sql.includes("type != 'cron' OR cron_expression IS NULL")
  )
  assert(!!nonCronStaleSelect, 'staleLeaseRecovery: non-cron stale-lease SELECT correct shape')

  scheduler._setCoord(null)
})

// ── 2026-06-10: coord-liveness gate on stale-lease recovery ──────────────────
//
// Origin: telemetry-batch fire 2026-06-10T04:23Z spawned 4 sibling workers in
// 4 min because cold-start binds breached STALE_DISPATCHING_MS. The bulk
// UPDATE freed the lease and the next poll re-dispatched mid-flight. Per
// [[scheduler-stale-lease-must-check-coord-worker-liveness-before-redispatch-2026-06-10]],
// each stale-lease branch now consults coord.list_workers and skips the
// re-dispatch if a non-dead heartbeating worker exists on the same task_id.

function makeSplitStubPool(opts) {
  // Returns different rows for the cron-stale SELECT vs the non-cron-stale
  // SELECT so focused liveness tests can exercise one branch at a time.
  const cronRows = opts.cronRows || []
  const nonCronRows = opts.nonCronRows || []
  const orphanRows = opts.orphanRows || []
  const queries = []
  return {
    _queries: queries,
    query(sql, params) {
      queries.push({ sql, params: params || [] })
      if (sql.includes('SELECT') && sql.includes("type = 'cron'")) {
        return Promise.resolve({ rows: cronRows, rowCount: cronRows.length })
      }
      if (sql.includes('SELECT') && sql.includes("type != 'cron'")) {
        return Promise.resolve({ rows: nonCronRows, rowCount: nonCronRows.length })
      }
      if (sql.includes('SELECT') && sql.includes("status = 'running'")) {
        return Promise.resolve({ rows: orphanRows, rowCount: orphanRows.length })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
  }
}

test('staleLeaseRecovery cron branch: live worker -> skip UPDATE, lease intact', async () => {
  const pool = makeSplitStubPool({
    cronRows: [{ id: 'task-cron-1', cron_expression: '0 9 * * *', tz: 'Australia/Brisbane' }]
  })
  scheduler._setPool(pool)
  scheduler._setCoord({
    list_workers: async () => ({
      count: 1,
      workers: [{
        tab_id: 'tab_alive_1',
        task_id: 'task-cron-1',
        last_heartbeat_at: new Date().toISOString(),
        stale_ms: 4_000,
        dead: false,
        terminated_at: null,
      }]
    })
  })

  await scheduler.staleLeaseRecovery()

  const perRowUpdate = pool._queries.find(q =>
    q.sql.includes('UPDATE os_scheduled_tasks') &&
    q.sql.includes('deferred to next interval per doctrine')
  )
  assert(!perRowUpdate, 'cron branch: no per-row UPDATE emitted when a live worker holds the task')

  scheduler._setCoord(null)
})

test('staleLeaseRecovery non-cron branch: live worker -> skip UPDATE, lease intact', async () => {
  const pool = makeSplitStubPool({
    nonCronRows: [{ id: 'task-delayed-1' }]
  })
  scheduler._setPool(pool)
  scheduler._setCoord({
    list_workers: async () => ({
      count: 1,
      workers: [{
        tab_id: 'tab_alive_2',
        task_id: 'task-delayed-1',
        last_heartbeat_at: new Date().toISOString(),
        stale_ms: 12_000,
        dead: false,
        terminated_at: null,
      }]
    })
  })

  await scheduler.staleLeaseRecovery()

  const perRowFail = pool._queries.find(q =>
    q.sql.includes('UPDATE os_scheduled_tasks') &&
    q.sql.includes("status = 'failed'") &&
    q.sql.includes('stale lease - max retries exhausted')
  )
  assert(!perRowFail, 'non-cron branch: no per-row failure UPDATE when a live worker holds the task')

  scheduler._setCoord(null)
})

test('staleLeaseRecovery non-cron branch: no live worker -> per-row UPDATE fires', async () => {
  const pool = makeSplitStubPool({
    nonCronRows: [{ id: 'task-delayed-2' }]
  })
  scheduler._setPool(pool)
  scheduler._setCoord({ list_workers: async () => ({ count: 0, workers: [] }) })

  await scheduler.staleLeaseRecovery()

  const perRowFail = pool._queries.find(q =>
    q.sql.includes('UPDATE os_scheduled_tasks') &&
    q.sql.includes("status = 'failed'") &&
    q.sql.includes('stale lease - max retries exhausted')
  )
  assert(!!perRowFail, 'non-cron branch: per-row failure UPDATE fires when no live worker exists')
  assert(perRowFail && perRowFail.params[0] === 'task-delayed-2', 'non-cron branch: UPDATE targets the stale row by id')

  scheduler._setCoord(null)
})

test('staleLeaseRecovery: stale worker (stale_ms >= 180s) does not count as live', async () => {
  const pool = makeSplitStubPool({
    nonCronRows: [{ id: 'task-delayed-3' }]
  })
  scheduler._setPool(pool)
  scheduler._setCoord({
    list_workers: async () => ({
      count: 1,
      workers: [{
        tab_id: 'tab_zombie',
        task_id: 'task-delayed-3',
        last_heartbeat_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        stale_ms: 300_000,
        dead: false,
        terminated_at: null,
      }]
    })
  })

  await scheduler.staleLeaseRecovery()

  const perRowFail = pool._queries.find(q =>
    q.sql.includes('UPDATE os_scheduled_tasks') &&
    q.sql.includes("status = 'failed'")
  )
  assert(!!perRowFail, 'non-cron branch: zombie worker past liveness window does not block UPDATE')

  scheduler._setCoord(null)
})

test('staleLeaseRecovery: coord error fails open (UPDATE still fires)', async () => {
  const pool = makeSplitStubPool({
    nonCronRows: [{ id: 'task-delayed-4' }]
  })
  scheduler._setPool(pool)
  scheduler._setCoord({
    list_workers: async () => { throw new Error('coord unreachable') }
  })

  await scheduler.staleLeaseRecovery()

  const perRowFail = pool._queries.find(q =>
    q.sql.includes('UPDATE os_scheduled_tasks') &&
    q.sql.includes("status = 'failed'")
  )
  assert(!!perRowFail, 'fail-open: coord unreachable does not block stale-lease recovery')

  scheduler._setCoord(null)
})

// ── Task 3.4: start() schedules 4 intervals (3 core + Phase 7 cap observer) ──

test('start() schedules exactly 4 setIntervals and returns 4 handles', async () => {
  const origSetInterval = global.setInterval
  const origClearInterval = global.clearInterval
  let callCount = 0
  const savedHandles = []
  global.setInterval = function (fn, ms) {
    callCount++
    const handle = { _id: callCount, unref: () => {} }
    savedHandles.push(handle)
    return handle
  }
  global.clearInterval = function (h) {}  // noop for cleanup in test

  const pool = makeStubPool([])
  scheduler._setPool(pool)
  scheduler._setDispatcher({ dispatch_worker: async () => ({}), kill_worker: async () => {} })

  const handles = scheduler.start()

  global.setInterval = origSetInterval
  global.clearInterval = origClearInterval

  assert(callCount === 4, 'start(): setInterval called 4 times (got ' + callCount + ')')
  assert(handles && handles.dispatchInterval, 'start(): returns dispatchInterval')
  assert(handles && handles.completionInterval, 'start(): returns completionInterval')
  assert(handles && handles.staleInterval, 'start(): returns staleInterval')
  assert(handles && handles.capObserverInterval, 'start(): returns capObserverInterval')
})

// ── Task 3.4: startupCleanup tolerates close_tab errors ──────────────────────

test('startupCleanup: tolerates close_tab errors and still nulls dispatched_tab_id', async () => {
  const pool = makeStubPool([{ id: 'task-startup-1', dispatched_tab_id: 'tab_old_123' }])
  scheduler._setPool(pool)

  scheduler._setDispatcher({
    kill_worker: async () => { throw new Error('close_tab intentional error') },
    dispatch_worker: async () => ({})
  })

  let threw = false
  try {
    await scheduler.startupCleanup()
  } catch (e) {
    threw = true
  }

  assert(!threw, 'startupCleanup: no throw despite kill_worker error')
  const nullUpdate = pool._queries.find(q => q.sql.includes('dispatched_tab_id = NULL'))
  assert(!!nullUpdate, 'startupCleanup: dispatched_tab_id nulled despite close_tab error')
})

// ── SCHEDULER_ENABLED default off ─────────────────────────────────────────────

test('SCHEDULER_ENABLED default is not "true"', async () => {
  const val = process.env.SCHEDULER_ENABLED
  assert(!val || val !== 'true', 'SCHEDULER_ENABLED: not "true" in default env (default off)')
})

// ── Phase 7: usage-cap observer ───────────────────────────────────────────────
//
// These tests need creds.js to read a SANDBOXED .credentials.json + per-account
// dir, so we set up isolated temp dirs and re-require creds with the new env.

const _capObsFs = require('fs')
const _capObsPath = require('path')
const _capObsOs = require('os')
const _capObsTmp = _capObsFs.mkdtempSync(_capObsPath.join(_capObsOs.tmpdir(), 'sched-capobs-'))
const _capObsCredsDir = _capObsPath.join(_capObsTmp, 'creds')
_capObsFs.mkdirSync(_capObsCredsDir, { recursive: true })
const _capObsClaudePath = _capObsPath.join(_capObsTmp, 'claude', '.credentials.json')
_capObsFs.mkdirSync(_capObsPath.dirname(_capObsClaudePath), { recursive: true })

const _capObsTate = { claudeAiOauth: { accessToken: 'AT-tate-capobs', refreshToken: 'RT-tate-capobs', expiresAt: 9999999999000 } }
const _capObsCode = { claudeAiOauth: { accessToken: 'AT-code-capobs', refreshToken: 'RT-code-capobs', expiresAt: 9999999999000 } }
const _capObsMoney = { claudeAiOauth: { accessToken: 'AT-money-capobs', refreshToken: 'RT-money-capobs', expiresAt: 9999999999000 } }
_capObsFs.writeFileSync(_capObsPath.join(_capObsCredsDir, 'tate.json'), JSON.stringify(_capObsTate))
_capObsFs.writeFileSync(_capObsPath.join(_capObsCredsDir, 'code.json'), JSON.stringify(_capObsCode))
_capObsFs.writeFileSync(_capObsPath.join(_capObsCredsDir, 'money.json'), JSON.stringify(_capObsMoney))

// Rebind creds env + clear module cache so creds.js re-binds to sandbox paths.
process.env.CREDS_DIR = _capObsCredsDir
process.env.CLAUDE_CREDENTIALS_PATH = _capObsClaudePath
delete require.cache[require.resolve('./creds')]
const _capObsCreds = require('./creds')
_capObsCreds._setUsageSource({
  get_usage_state: (account) => {
    const states = {
      tate: { headroom_minutes: 5, reset_at: '2026-12-31T00:00:00Z' },
      code: { headroom_minutes: 200, reset_at: '2026-12-31T00:00:00Z' },
      money: { headroom_minutes: 100, reset_at: '2026-12-31T00:00:00Z' },
    }
    return states[account]
  }
})

test('checkCapWarning: skips when current account is unknown', async () => {
  // Inject a stub creds module returning 'unknown' so we don't depend on
  // the real ~/.claude/.credentials.json (which DOES exist in dev).
  scheduler._setCredsModule({
    current_account: () => 'unknown',
    pick_healthiest_account: async () => null,
  })
  scheduler._resetCapWarningLast()
  const stubPool = makeStubPool([])
  scheduler._setPool(stubPool)
  scheduler._setUsageModule({ get_usage_state: async () => ({ state: {} }) })
  const result = await scheduler.checkCapWarning()
  assert(result.skipped === 'no_current_account', 'returns skipped=no_current_account when unknown')
  // Restore the sandbox creds for subsequent tests.
  delete require.cache[require.resolve('./creds')]
  scheduler._setCredsModule(require('./creds'))
})

test('checkCapWarning: skips when headroom is ample', async () => {
  // Seed credentials with tate.json -> current_account = 'tate'.
  _capObsFs.copyFileSync(_capObsPath.join(_capObsCredsDir, 'tate.json'), _capObsClaudePath)
  scheduler._resetCapWarningLast()
  const stubPool = makeStubPool([])
  scheduler._setPool(stubPool)
  scheduler._setUsageModule({
    get_usage_state: async () => ({
      state: {
        tate: { headroom_minutes: 200 },
        code: { headroom_minutes: 100 },
        money: { headroom_minutes: 50 }
      }
    })
  })
  const result = await scheduler.checkCapWarning()
  assert(result.skipped === 'headroom_ample', 'returns skipped=headroom_ample at 200min')
})

test('checkCapWarning: fires INSERT when headroom is low + writes observer signal', async () => {
  _capObsFs.copyFileSync(_capObsPath.join(_capObsCredsDir, 'tate.json'), _capObsClaudePath)
  scheduler._resetCapWarningLast()
  const stubPool = makeStubPool([])
  scheduler._setPool(stubPool)
  scheduler._setUsageModule({
    get_usage_state: async () => ({
      state: {
        tate: { headroom_minutes: 5 },
        code: { headroom_minutes: 200 },
        money: { headroom_minutes: 100 }
      }
    })
  })

  const result = await scheduler.checkCapWarning()
  assert(result.fired === true, 'returns fired=true')
  assert(result.current === 'tate', 'identifies current=tate')
  const insertCalls = stubPool._queries.filter(q => q.sql.includes('INSERT INTO observer_signals'))
  assert(insertCalls.length === 1, 'wrote exactly one observer_signals row')
  assert(insertCalls[0].params[0] === 'autonomy-substrate-usage-cap-observer', 'observer_name set')
  assert(insertCalls[0].params[1] === 'usage_cap_warning', 'signal_kind set')
  assert(insertCalls[0].params[2].includes('Current account (tate)') && insertCalls[0].params[2].includes('5 minutes'), 'message includes account + headroom')
  assert(insertCalls[0].params[3].startsWith('usage_cap:tate:'), 'fingerprint scoped to account')
})

test('checkCapWarning: cooldown prevents double-fire within 1h', async () => {
  _capObsFs.copyFileSync(_capObsPath.join(_capObsCredsDir, 'tate.json'), _capObsClaudePath)
  scheduler._resetCapWarningLast()
  const stubPool = makeStubPool([])
  scheduler._setPool(stubPool)
  scheduler._setUsageModule({
    get_usage_state: async () => ({
      state: {
        tate: { headroom_minutes: 5 },
        code: { headroom_minutes: 200 },
        money: { headroom_minutes: 100 }
      }
    })
  })

  const first = await scheduler.checkCapWarning()
  const second = await scheduler.checkCapWarning()
  assert(first.fired === true, 'first call fires')
  assert(second.skipped === 'cooldown', 'second call within cooldown is skipped')
  const insertCalls = stubPool._queries.filter(q => q.sql.includes('INSERT INTO observer_signals'))
  assert(insertCalls.length === 1, 'exactly one INSERT despite two calls')
})

// ── sequential test runner ────────────────────────────────────────────────────

async function runAll() {
  for (const { name, fn } of tests) {
    console.log('\n--', name, '--')
    try {
      await fn()
    } catch (e) {
      console.error('  UNCAUGHT IN TEST:', e.message)
      failed++
    }
  }

  console.log('\n===========================================')
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed')
  if (failed > 0) {
    console.error(failed + ' test(s) FAILED')
    process.exit(1)
  } else {
    console.log('All tests passed.')
    process.exit(0)
  }
}

runAll()
