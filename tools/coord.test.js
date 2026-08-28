// coord.test.js - unit tests for coord.js signal_bound and related messaging.
//
// Run with: node tools/coord.test.js
// Exit code 0 = all pass, non-zero = failure.
//
// Sandboxes the coord substrate into a temp dir to avoid clobbering real state.
// Mirrors the monkey-patch technique used in usage.test.js.

const fs = require('fs')
const path = require('path')
const os = require('os')

// ── sandbox setup (BEFORE requiring coord.js) ────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-test-'))
const FAKE_COORD = path.join(TMP, 'coordination')
fs.mkdirSync(FAKE_COORD, { recursive: true })

// coord.js resolves COORD_ROOT from the environment at require time, so binding it to the
// sandbox here is the actual isolation. Same Corazon-era trap fixed in usage.test.js
// (2026-08-02): this file used to hardcode 'D:\\.code\\EcodiaOS\\coordination' and proxy fs
// to reroute that path, which only isolated anything if the caller happened to export the
// same Windows string as COORD_ROOT. With COORD_ROOT unset on this Mac, coord.js bound
// ~/.ecodiaos/coordination and the tests wrote PRODUCTION worker rows; with any other
// sandbox value the assertions read from a directory coord.js never wrote (ENOENT on the
// signal_bound read-back). The fs proxy below stays as a no-op safety mapper.
process.env.COORD_ROOT = FAKE_COORD
const REAL_COORD = FAKE_COORD

const realReadFileSync = fs.readFileSync
const realWriteFileSync = fs.writeFileSync
const realMkdirSync = fs.mkdirSync
const realRenameSync = fs.renameSync
const realReaddirSync = fs.readdirSync
const realStatSync = fs.statSync
const realExistsSync = fs.existsSync
const realUnlinkSync = fs.unlinkSync

function reroute(p) {
  if (typeof p !== 'string') return p
  if (p.startsWith(REAL_COORD)) return p.replace(REAL_COORD, FAKE_COORD)
  return p
}

fs.readFileSync = function(p, ...rest) { return realReadFileSync(reroute(p), ...rest) }
fs.writeFileSync = function(p, ...rest) { return realWriteFileSync(reroute(p), ...rest) }
fs.mkdirSync = function(p, ...rest) { return realMkdirSync(reroute(p), ...rest) }
fs.renameSync = function(a, b, ...rest) { return realRenameSync(reroute(a), reroute(b), ...rest) }
fs.readdirSync = function(p, ...rest) {
  try { return realReaddirSync(reroute(p), ...rest) } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}
fs.statSync = function(p, ...rest) { return realStatSync(reroute(p), ...rest) }
fs.existsSync = function(p, ...rest) { return realExistsSync(reroute(p), ...rest) }
fs.unlinkSync = function(p, ...rest) { return realUnlinkSync(reroute(p), ...rest) }

// Disable sweep loop during tests (avoids timer leaks and stdout noise).
process.env.COORD_DISABLE_SWEEP = '1'

const coord = require('./coord')

// ── helpers ──────────────────────────────────────────────────────────────────

let failures = 0
function assertEq(actual, expected, msg) {
  if (actual === expected) {
    console.log('  PASS:', msg)
  } else {
    console.log('  FAIL:', msg, '-- expected', JSON.stringify(expected), 'got', JSON.stringify(actual))
    failures++
  }
}
function assertTrue(cond, msg) { assertEq(!!cond, true, msg) }
function assertFalse(cond, msg) { assertEq(!!cond, false, msg) }

// Read all unread messages on the given topic from the inbox without marking seen.
async function peekAll(topic) {
  const r = await coord.peek_inbox({ topic }, {})
  return r.messages
}

// ── worker-lifecycle fixture (2026-08-28, lane R1 item 2) ────────────────────
//
// signal_bound / signal_done / report_progress now write os_scheduled_tasks
// through tools/task-signals.js. There is no database here, so this stub pool
// stands in for the table. It is deliberately a MODEL, not a yes-machine: it
// enforces the same predicate the real SQL does (the write applies only when
// dispatched_tab_id equals the calling tab) and it MUTATES, so a test can assert
// the ABSENCE of a write rather than only the presence of an error. A stub that
// always answered rowCount 1 would score a broken guard green, and a stub that
// never mutated would make an absence assertion vacuously true.
//
// Task ids are real uuids because os_scheduled_tasks.id is a uuid column and
// task-signals refuses a non-uuid by name rather than letting Postgres raise
// 22P02 out of the MCP surface.
const taskSignals = require('./task-signals')

const TASK_OWNED  = '11111111-1111-4111-8111-111111111111'
const TASK_SIX    = '66666666-6666-4666-8666-666666666666'
const TASK_ORPHAN = '99999999-9999-4999-8999-999999999999'  // no row: a hand-spawned worker
const TAB_OWNER   = 'tab_owner_1'

const signalRows = {
  [TASK_OWNED]: { dispatched_tab_id: TAB_OWNER },
}

taskSignals._setPool({
  query: async (sql, params) => {
    const taskId = params[0]
    const tabId = params[1]
    const row = signalRows[taskId]
    // The guard, modelled exactly: no row, or a row dispatched elsewhere, matches nothing.
    if (!row || row.dispatched_tab_id !== tabId) return { rows: [], rowCount: 0 }
    if (/bound_at = NOW\(\)/.test(sql)) {
      row.bound_at = new Date().toISOString()
      row.bound_tab_id = tabId
    } else if (/done_at = NOW\(\)/.test(sql)) {
      row.done_at = new Date().toISOString()
      row.done_status = params[2]
      row.done_summary = params[3]
      row.done_pointer = params[4]
    } else if (/progress_at = NOW\(\)/.test(sql)) {
      row.progress_at = new Date().toISOString()
      row.progress_summary = params[2]
    } else {
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 1 }
  },
})

// ── tests ────────────────────────────────────────────────────────────────────

async function runTests() {

  // ── TEST 1: signal_bound is a function ─────────────────────────────────
  console.log('TEST 1: signal_bound is exported and callable')
  assertTrue(typeof coord.signal_bound === 'function', 'coord.signal_bound is a function')

  // ── TEST 2: signal_bound writes the ROW, and posts NO message ───────────
  //
  // 2026-08-28 lane R1 item 2. This replaces three assertions that a `bound`
  // MESSAGE landed on chat.conductor.inbox. bound is a machine handshake between
  // one worker and the scheduler: no human ever wanted a toast for it, the wake
  // policy never listed it, and 2,797 of them had accumulated as sediment on an
  // inbox that serves oldest-first. It now stamps bound_at on the worker's own
  // scheduled row.
  //
  // The absence assertion is the load-bearing one. A migration that kept writing
  // the message alongside the column would pass every "the column was written"
  // check while leaving the backlog exactly as it was.
  console.log('TEST 2: signal_bound stamps bound_at on the row and posts NO message')
  const before2 = (await peekAll('chat.conductor.inbox')).length
  const r2 = await coord.signal_bound({ task_id: TASK_OWNED }, { tab_id: TAB_OWNER })
  assertTrue(!!(r2 && r2.ok), 'signal_bound returns ok:true for the tab that owns the row')
  assertTrue(!!signalRows[TASK_OWNED].bound_at, 'bound_at stamped on the scheduled row')
  assertEq(signalRows[TASK_OWNED].bound_tab_id, TAB_OWNER, 'bound_tab_id records WHICH tab bound')
  const after2 = await peekAll('chat.conductor.inbox')
  assertEq(after2.length, before2, 'signal_bound wrote NO message to chat.conductor.inbox')
  assertFalse(
    after2.some(m => m.body && m.body.type === 'bound'),
    'no message of type "bound" exists at all (the type is retired, not renamed)'
  )

  // ── TEST 3: signal_bound does NOT terminate the worker row ──────────────
  console.log('TEST 3: signal_bound does not stamp terminated_at on the worker row')
  // Register a worker first so we can check its row after the signal.
  const testTabId = 'test-tab-bound-' + Date.now()
  const testCred = 'cred-' + testTabId
  const TASK_THREE = '33333333-3333-4333-8333-333333333333'
  signalRows[TASK_THREE] = { dispatched_tab_id: testTabId }
  coord._registerWorkerInternal({
    tab_id: testTabId,
    task_id: TASK_THREE,
    tab_credential: testCred,
    parent_conductor_tab_id: null,
    account_active_when_spawned: null,
  })

  await coord.signal_bound({ task_id: TASK_THREE }, { tab_id: testTabId, tab_credential: testCred })

  // Read the worker row back from disk to verify it is not terminated.
  const workerFile = path.join(FAKE_COORD, 'workers', testTabId + '.json')
  const row3 = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
  assertFalse(!!row3.terminated_at, 'worker row does NOT have terminated_at set after signal_bound')

  // ── TEST 4: signal_done still terminates as before ──────────────────────
  console.log('TEST 4: signal_done still terminates the worker row (regression)')
  const doneTabId = 'test-tab-done-' + Date.now()
  const doneCred = 'cred-' + doneTabId
  const TASK_FOUR = '44444444-4444-4444-8444-444444444444'
  signalRows[TASK_FOUR] = { dispatched_tab_id: doneTabId }
  coord._registerWorkerInternal({
    tab_id: doneTabId,
    task_id: TASK_FOUR,
    tab_credential: doneCred,
    parent_conductor_tab_id: null,
    account_active_when_spawned: null,
  })

  await coord.signal_done({ task_id: TASK_FOUR, result_summary: 'done regression test', terminate: true },
    { tab_id: doneTabId, tab_credential: doneCred })

  const doneFile = path.join(FAKE_COORD, 'workers', doneTabId + '.json')
  const row4 = JSON.parse(fs.readFileSync(doneFile, 'utf8'))
  assertTrue(!!row4.terminated_at, 'worker row HAS terminated_at after signal_done')

  // ── TEST 5: THE GUARD. A bind from a tab that does not own the row is ───
  //           refused, AND nothing is written.
  //
  // This is the whole reason the migration is more than a rename. Asserting the
  // refusal alone would be scored green by a broken implementation that returns
  // an error and applies the write anyway, which is the exact shape that let a
  // resolver bug survive sixteen commits on this same lane six hours earlier.
  // Assert the ABSENCE of the write.
  console.log('TEST 5: a bind from a non-owning tab is refused AND writes nothing')
  signalRows[TASK_OWNED].bound_at = null
  signalRows[TASK_OWNED].bound_tab_id = null
  const r5 = await coord.signal_bound({ task_id: TASK_OWNED }, { tab_id: 'tab_some_other_worker' })
  assertFalse(!!(r5 && r5.ok), 'signal_bound REFUSED for a tab that does not own the row')
  assertTrue(!!(r5 && r5.error), 'the refusal carries a named error')
  assertEq(signalRows[TASK_OWNED].bound_at, null, 'bound_at UNCHANGED: the refused write did not land')

  // POSITIVE CONTROL. Without it, a signal_bound that refused EVERYTHING (a
  // crashed require, a typo'd predicate) would pass the leg above. The same tab
  // that was just refused must succeed once it owns the row.
  signalRows[TASK_OWNED].dispatched_tab_id = 'tab_some_other_worker'
  const r5b = await coord.signal_bound({ task_id: TASK_OWNED }, { tab_id: 'tab_some_other_worker' })
  assertTrue(!!(r5b && r5b.ok), 'POSITIVE CONTROL: the same call succeeds once that tab owns the row')
  assertTrue(!!signalRows[TASK_OWNED].bound_at, 'POSITIVE CONTROL: bound_at written on the owning call')
  signalRows[TASK_OWNED].dispatched_tab_id = TAB_OWNER

  // A caller with no tab identity cannot prove ownership of anything.
  const r5c = await coord.signal_bound({ task_id: TASK_OWNED }, {})
  assertFalse(!!(r5c && r5c.ok), 'signal_bound with no ctx.tab_id is refused (cannot prove ownership)')

  // ── TEST 6: the conductor NOTICE survives, carrying what it used to ─────
  //
  // parent_conductor_tab_id was propagated into the bound message body so a
  // future multi-conductor wake could route per conductor. bound no longer
  // produces a message, so that routing hook has to live on the ONE message
  // signal_done still posts: the human-facing worker_report. Deleting the notice
  // outright would have silently removed wake-on-worker-finish, which is live
  // behaviour, so this pins that it is still there and still carries the field.
  console.log('TEST 6: signal_done posts a worker_report notice carrying parent_conductor_tab_id')
  const conductorTabId = 'conductor-tab-' + Date.now()
  const tab6 = 'test-tab-6-' + Date.now()
  coord._registerWorkerInternal({
    tab_id: tab6,
    task_id: TASK_SIX,
    tab_credential: 'cred-6',
    parent_conductor_tab_id: conductorTabId,
    account_active_when_spawned: null,
  })
  signalRows[TASK_SIX] = { dispatched_tab_id: tab6 }
  const r6 = await coord.signal_done(
    { task_id: TASK_SIX, status: 'success', result_summary: 'six done', result_pointer: 'file:///six' },
    { tab_id: tab6, tab_credential: 'cred-6' }
  )
  assertTrue(!!(r6 && r6.ok), 'signal_done ok:true reflects the ROW write, not the notice')
  assertEq(signalRows[TASK_SIX].done_status, 'success', 'done_status persisted on the row')
  assertEq(signalRows[TASK_SIX].done_summary, 'six done', 'done_summary persisted on the row')

  const msgs6 = await peekAll('chat.conductor.inbox')
  const rep6 = msgs6.find(m => m.body && m.body.type === 'worker_report' && m.body.task_id === TASK_SIX)
  assertTrue(!!rep6, 'a worker_report notice for the task exists')
  assertEq(rep6 && rep6.body.parent_conductor_tab_id, conductorTabId,
    'parent_conductor_tab_id propagated into the worker_report body')
  assertTrue(rep6 && rep6.body.signal_recorded === true,
    'the notice records whether the authoritative row write landed')
  assertFalse(
    msgs6.some(m => m.body && m.body.type === 'done'),
    'no message of type "done" is produced any more (the type is retired)'
  )

  // The other direction: when the row write is REFUSED the notice still goes out
  // (the worker really has stopped and a human should learn that), but it says
  // so rather than claiming success.
  const tab6b = 'test-tab-6b-' + Date.now()
  coord._registerWorkerInternal({
    tab_id: tab6b, task_id: TASK_ORPHAN, tab_credential: 'cred-6b',
    parent_conductor_tab_id: null, account_active_when_spawned: null,
  })
  const r6b = await coord.signal_done(
    { task_id: TASK_ORPHAN, status: 'success', result_summary: 'no row for me' },
    { tab_id: tab6b, tab_credential: 'cred-6b' }
  )
  assertFalse(!!(r6b && r6b.ok), 'signal_done ok:false when there is no matching dispatched row')
  const msgs6b = await peekAll('chat.conductor.inbox')
  const rep6b = msgs6b.find(m => m.body && m.body.type === 'worker_report' && m.body.task_id === TASK_ORPHAN)
  assertTrue(!!rep6b, 'the notice is still posted so the conductor wake still fires')
  assertTrue(rep6b && rep6b.body.signal_recorded === false,
    'the notice reports signal_recorded:false instead of implying the row completed')

  // ── TEST 7: read_inbox({ids}) consumes ONLY the given ids, leaving others ─
  // 2026-07-08 regression guard for the lost-signal_done defect. The conductor
  // turn hooks surface inbound_* messages and must dedupe ONLY those; a blanket
  // read_inbox marked the whole conductor inbox seen and ate worker done signals.
  console.log('TEST 7: read_inbox({ids}) marks seen ONLY the named ids; a sibling done survives')
  const t7topic = 'chat.conductor.inbox'
  // An inbound_ message (what the hook surfaces + should consume) ...
  const inbMsg = await coord.send_message(
    { to: t7topic, body: { type: 'inbound_sms', envelope: { channel: 'sms', body: 'hi' } } }, {})
  // ... and a worker done that MUST survive for coord_events_pending to surface.
  const doneMsg = await coord.send_message(
    { to: t7topic, body: { type: 'done', task_id: 'test-task-7', status: 'success', result_summary: 'must survive' } },
    {})
  // Targeted consume: only the inbound id.
  const consumed = await coord.read_inbox({ topic: t7topic, ids: [inbMsg.message_id] }, {})
  assertEq(consumed.count, 1, 'read_inbox({ids}) returned exactly the 1 named message')
  assertEq(consumed.messages[0] && consumed.messages[0].id, inbMsg.message_id, 'the returned message is the inbound one')
  // Now peek: the done must still be unseen/visible; the inbound must be gone.
  const after7 = await peekAll(t7topic)
  const doneStill = after7.find(m => m.id === doneMsg.message_id)
  const inbGone = !after7.find(m => m.id === inbMsg.message_id)
  assertTrue(!!doneStill, 'worker done message SURVIVES (not marked seen) after targeted inbound consume')
  assertTrue(inbGone, 'inbound message was consumed (marked seen) and no longer peekable')

  // ── summary ─────────────────────────────────────────────────────────────

  if (failures > 0) {
    console.log('\n' + failures + ' TEST(S) FAILED')
    process.exit(1)
  } else {
    console.log('\nALL TESTS PASSED')
    process.exit(0)
  }
}

runTests().catch(e => {
  console.error('UNCAUGHT:', e)
  process.exit(1)
})
