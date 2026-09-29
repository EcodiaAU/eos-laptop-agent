// scheduler.dispatch-precheck.test.js - the pre-spawn precheck gate (2026-09-29).
//
// Proves, with no database, no IDE and no real subprocess:
//   A. dispatch-precheck.run FAILS OPEN on every bad path (no entry, disabled entry,
//      wrong row type, bad argv, non-zero exit, timeout, garbage, a runner that
//      throws, a missing registry) and returns skip ONLY on the exact verdict "skip".
//   B. dispatchOne on a cron row whose precheck says skip: NO worker is dispatched,
//      NO running-flip happens, and the lease is released by an UPDATE that defers
//      next_run_at to a FUTURE slot and records precheck-skip in last_result.
//   C. dispatchOne on a spawn verdict, a timeout, and a row with no entry all
//      dispatch exactly as before, and the no-entry row never runs a precheck.
//
// Run: node tools/scheduler.dispatch-precheck.test.js   (exit 0 = pass)
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const scheduler = require('./scheduler')
const precheck = require('./dispatch-precheck')
const credsModule = require('./creds')
const coordModule = require('./coord')

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}

const REG = path.join(os.tmpdir(), 'eos-precheck-reg-' + process.pid + '.json')
function writeReg(prechecks) { fs.writeFileSync(REG, JSON.stringify({ prechecks })) }
const ENTRY = { enabled: true, types: ['cron'], timeout_ms: 5000, argv: ['/bin/echo', 'x'] }

function makeRow(o) {
  return Object.assign({
    id: 'task-pc-1', name: 'gmail-inbox-poll', type: 'cron', status: 'dispatching',
    cron_expression: '0 7,10,13,16,19 * * *', tz: 'Australia/Brisbane',
    prompt: 'poll', preferred_account: 'tate', actual_account: null, retry_count: 0,
    dispatched_tab_id: null, leased_by: 'agent-test',
  }, o || {})
}

// Minimal copy of scheduler.test.js makeStubPool: bound immediately, claim
// UPDATE and lease refresh match the held row.
function makeStubPool() {
  const queries = []
  return {
    _queries: queries,
    query(sql, params) {
      queries.push({ sql, params: params || [] })
      if (/^\s*SELECT\s+bound_at/i.test(sql)) {
        return Promise.resolve({ rows: [{ bound_at: new Date().toISOString(), bound_tab_id: 'tab_pc', done_at: null }], rowCount: 1 })
      }
      if (/UPDATE\s+os_scheduled_tasks\s+SET dispatched_tab_id = \$1, bound_at = NULL/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 })
      if (sql.trim().toUpperCase().startsWith('SELECT') || sql.includes('RETURNING')) return Promise.resolve({ rows: [], rowCount: 0 })
      if (/UPDATE\s+os_scheduled_tasks\s+SET\s+leased_at = NOW\(\), updated_at = NOW\(\)\s+WHERE/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 })
      if (/precheck-skip|last_result = \$4/.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
  }
}

function stubDispatchEnv() {
  scheduler._setWorktreeFns({ allocate: async () => '/tmp/test-worktree', prune: async () => {} })
  const saved = {
    pick: credsModule.pick_healthiest_account, current: credsModule.current_account,
    peek: coordModule.peek_inbox, read: coordModule.read_inbox, ack: coordModule.ack_message,
  }
  credsModule.pick_healthiest_account = async () => 'tate'
  credsModule.current_account = () => 'tate'
  coordModule.peek_inbox = async () => ({ messages: [] })
  coordModule.read_inbox = async () => ({ messages: [] })
  coordModule.ack_message = async () => ({})
  const calls = { dispatched: 0 }
  scheduler._setDispatcher({
    dispatch_worker: async (p) => { calls.dispatched++; return { ok: true, tab_id: 'tab_pc', task_id: p.task_id } },
    kill_worker: async () => {},
  })
  calls.restore = () => {
    credsModule.pick_healthiest_account = saved.pick; credsModule.current_account = saved.current
    coordModule.peek_inbox = saved.peek; coordModule.read_inbox = saved.read; coordModule.ack_message = saved.ack
  }
  return calls
}

;(async () => {
  precheck._setRegistryPath(REG)

  // ---------------------------------------------------------------- A ----
  const runWith = async (runner, row, reg) => {
    writeReg(reg || { 'gmail-inbox-poll': ENTRY })
    precheck._setRunner(runner)
    return precheck.run(row || makeRow())
  }
  const ok = (stdout) => async () => ({ code: 0, stdout, timedOut: false })

  await check('A1 skip ONLY on the exact verdict "skip"', async () => {
    const r = await runWith(ok('noise\n{"verdict":"skip","reason":"nothing"}\n'))
    assert.strictEqual(r.verdict, 'skip'); assert.strictEqual(r.reason, 'nothing')
  })
  await check('A2 spawn verdict is a spawn', async () => {
    const r = await runWith(ok('{"verdict":"spawn","reason":"JUDGE 3"}'))
    assert.strictEqual(r.verdict, 'spawn'); assert.strictEqual(r.cause, 'verdict')
  })
  await check('A3 "Skip" / "skip " / true are NOT skip', async () => {
    for (const v of ['"Skip"', '"skip "', 'true', '"SKIP"']) {
      const r = await runWith(ok('{"verdict":' + v + '}'))
      assert.strictEqual(r.verdict, 'spawn', v)
    }
  })
  await check('A4 non-zero exit is a spawn even with a skip line', async () => {
    const r = await runWith(async () => ({ code: 1, stdout: '{"verdict":"skip"}', timedOut: false }))
    assert.strictEqual(r.verdict, 'spawn'); assert.strictEqual(r.cause, 'exit-1')
  })
  await check('A5 timeout is a spawn even with a skip line', async () => {
    const r = await runWith(async () => ({ code: -1, stdout: '{"verdict":"skip"}', timedOut: true }))
    assert.strictEqual(r.verdict, 'spawn'); assert.strictEqual(r.cause, 'timeout')
  })
  await check('A6 unparseable last line is a spawn (a skip line earlier does not count)', async () => {
    const r = await runWith(ok('{"verdict":"skip"}\nERR socket hang up'))
    assert.strictEqual(r.verdict, 'spawn'); assert.strictEqual(r.cause, 'unparseable')
  })
  await check('A7 a runner that throws is a spawn and run() does not reject', async () => {
    const r = await runWith(async () => { throw new Error('boom') })
    assert.strictEqual(r.verdict, 'spawn'); assert.strictEqual(r.cause, 'runner-threw')
  })
  await check('A8 no entry for the name is no-entry and the runner is NOT called', async () => {
    let called = false
    const r = await runWith(async () => { called = true; return { code: 0, stdout: '{"verdict":"skip"}' } }, makeRow({ name: 'calendar-watch' }))
    assert.strictEqual(r.cause, 'no-entry'); assert.strictEqual(called, false)
  })
  await check('A9 enabled:false bypasses', async () => {
    const r = await runWith(ok('{"verdict":"skip"}'), null, { 'gmail-inbox-poll': Object.assign({}, ENTRY, { enabled: false }) })
    assert.strictEqual(r.cause, 'no-entry')
  })
  await check('A10 a one-shot row with a cron-only entry is not prechecked', async () => {
    const r = await runWith(ok('{"verdict":"skip"}'), makeRow({ type: 'delayed' }))
    assert.strictEqual(r.cause, 'no-entry')
  })
  await check('A11 a relative executable is refused (bad-entry, spawn)', async () => {
    const r = await runWith(ok('{"verdict":"skip"}'), null, { 'gmail-inbox-poll': Object.assign({}, ENTRY, { argv: ['node', 'x.cjs'] }) })
    assert.strictEqual(r.verdict, 'spawn'); assert.strictEqual(r.cause, 'bad-entry')
  })
  await check('A12 a missing registry file is no-entry', async () => {
    precheck._setRegistryPath(REG + '.absent'); precheck._setRunner(ok('{"verdict":"skip"}'))
    const r = await precheck.run(makeRow())
    precheck._setRegistryPath(REG)
    assert.strictEqual(r.cause, 'no-entry')
  })
  await check('A13 the real runner passes the row id to the child and reads its verdict', async () => {
    writeReg({ 'gmail-inbox-poll': Object.assign({}, ENTRY, { argv: ['/bin/sh', '-c', 'echo "{\\"verdict\\":\\"skip\\",\\"reason\\":\\"$EOS_PRECHECK_ROW_ID\\"}"'] }) })
    precheck._setRunner(null)
    const r = await precheck.run(makeRow({ id: 'row-xyz' }))
    assert.strictEqual(r.verdict, 'skip'); assert.strictEqual(r.reason, 'row-xyz')
  })
  await check('A14 the real runner kills a hung child at timeout_ms and spawns', async () => {
    writeReg({ 'gmail-inbox-poll': Object.assign({}, ENTRY, { timeout_ms: 1000, argv: ['/bin/sh', '-c', 'sleep 5; echo "{\\"verdict\\":\\"skip\\"}"'] }) })
    precheck._setRunner(null)
    const t0 = Date.now()
    const r = await precheck.run(makeRow())
    assert.strictEqual(r.verdict, 'spawn'); assert.strictEqual(r.cause, 'timeout')
    assert.ok(Date.now() - t0 < 4000, 'timeout was not enforced')
  })

  // ---------------------------------------------------------------- B/C --
  const dispatchWith = async (runner, row) => {
    writeReg({ 'gmail-inbox-poll': ENTRY })
    precheck._setRunner(runner)
    const pool = makeStubPool(); scheduler._setPool(pool)
    const env = stubDispatchEnv()
    try { await scheduler.dispatchOne(row || makeRow()) } finally { env.restore() }
    return { pool, dispatched: env.dispatched }
  }

  await check('B1 skip verdict: no worker dispatched, no running-flip', async () => {
    const { pool, dispatched } = await dispatchWith(ok('{"verdict":"skip","reason":"JUDGE 0"}'))
    assert.strictEqual(dispatched, 0, 'dispatch_worker was called on a skip')
    assert.ok(!pool._queries.some(q => q.sql.includes("status = 'running'")), 'row flipped to running on a skip')
  })
  await check('B2 skip verdict: lease released, next_run_at deferred to a FUTURE slot, precheck-skip recorded', async () => {
    const { pool } = await dispatchWith(ok('{"verdict":"skip","reason":"JUDGE 0"}'))
    const u = pool._queries.find(q => /last_result = \$4/.test(q.sql))
    assert.ok(u, 'no skip UPDATE issued')
    assert.match(u.sql, /leased_by = NULL, leased_at = NULL/)
    assert.match(u.sql, /status = 'dispatching'/, 'skip UPDATE is not guarded on still holding the lease')
    assert.match(u.sql, /last_run_at = NOW\(\)/)
    // Without this the row returns to active past-due and is re-leased every 30s,
    // re-running a ~60s check under the launch-lock (mutation caught 2026-09-29).
    assert.match(u.sql, /next_run_at = \$3/, 'skip UPDATE does not re-arm next_run_at')
    assert.ok(!/run_count/.test(u.sql), 'a skip must not bump run_count (it counts worker fires)')
    assert.ok(Date.parse(u.params[2]) > Date.now(), 'next_run_at not in the future: ' + u.params[2])
    assert.match(u.params[3], /^precheck-skip: .*JUDGE 0/)
  })
  await check('C1 spawn verdict dispatches exactly as before', async () => {
    const { dispatched } = await dispatchWith(ok('{"verdict":"spawn","reason":"JUDGE 4"}'))
    assert.strictEqual(dispatched, 1)
  })
  await check('C2 a timed-out precheck dispatches (fail open)', async () => {
    const { dispatched } = await dispatchWith(async () => ({ code: -1, stdout: '', timedOut: true }))
    assert.strictEqual(dispatched, 1)
  })
  await check('C3 a row with no entry dispatches and never runs a precheck', async () => {
    let called = false
    const { dispatched, pool } = await dispatchWith(async () => { called = true; return { code: 0, stdout: '{"verdict":"skip"}' } }, makeRow({ name: 'calendar-watch' }))
    assert.strictEqual(dispatched, 1); assert.strictEqual(called, false)
    assert.ok(!pool._queries.some(q => /precheck-skip/.test(JSON.stringify(q.params))), 'no-entry row got a skip write')
  })
  await check('C4 a skip verdict on a ONE-SHOT row (entry lists delayed) still dispatches: no slot to defer to', async () => {
    writeReg({ 'gmail-inbox-poll': Object.assign({}, ENTRY, { types: ['cron', 'delayed'] }) })
    precheck._setRunner(ok('{"verdict":"skip"}'))
    const pool = makeStubPool(); scheduler._setPool(pool)
    const env = stubDispatchEnv()
    try { await scheduler.dispatchOne(makeRow({ id: 'task-pc-oneshot', type: 'delayed', cron_expression: null })) } finally { env.restore() }
    assert.strictEqual(env.dispatched, 1)
  })

  precheck._setRunner(null)
  precheck._setRegistryPath(null)
  try { fs.unlinkSync(REG) } catch (e) {}
  console.log(failures === 0 ? '\nALL PASS (scheduler.dispatch-precheck)' : '\n' + failures + ' FAILING (scheduler.dispatch-precheck)')
  process.exit(failures === 0 ? 0 : 1)
})().catch(e => { console.error('harness error: ' + e.stack); process.exit(2) })
