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

const REAL_COORD = 'D:\\.code\\EcodiaOS\\coordination'

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

// ── tests ────────────────────────────────────────────────────────────────────

async function runTests() {

  // ── TEST 1: signal_bound is a function ─────────────────────────────────
  console.log('TEST 1: signal_bound is exported and callable')
  assertTrue(typeof coord.signal_bound === 'function', 'coord.signal_bound is a function')

  // ── TEST 2: signal_bound posts to chat.conductor.inbox with type="bound" ─
  console.log('TEST 2: signal_bound posts body.type="bound" to chat.conductor.inbox')
  const r2 = await coord.signal_bound({ task_id: 'test-task-1' }, {})
  assertTrue(r2 && r2.message_id, 'returns a result with message_id')

  const msgs2 = await peekAll('chat.conductor.inbox')
  const bound2 = msgs2.find(m => m.body && m.body.type === 'bound' && m.body.task_id === 'test-task-1')
  assertTrue(!!bound2, 'bound message with correct task_id found in chat.conductor.inbox')
  assertEq(bound2 && bound2.body.type, 'bound', 'body.type is "bound"')
  assertEq(bound2 && bound2.body.task_id, 'test-task-1', 'body.task_id is "test-task-1"')

  // ── TEST 3: signal_bound does NOT terminate the worker row ──────────────
  console.log('TEST 3: signal_bound does not stamp terminated_at on the worker row')
  // Register a worker first so we can check its row after the signal.
  const testTabId = 'test-tab-bound-' + Date.now()
  const testCred = 'cred-' + testTabId
  coord._registerWorkerInternal({
    tab_id: testTabId,
    task_id: 'test-task-3',
    tab_credential: testCred,
    parent_conductor_tab_id: null,
    account_active_when_spawned: null,
  })

  await coord.signal_bound({ task_id: 'test-task-3' }, { tab_id: testTabId, tab_credential: testCred })

  // Read the worker row back from disk to verify it is not terminated.
  const workerFile = path.join(FAKE_COORD, 'workers', testTabId + '.json')
  const row3 = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
  assertFalse(!!row3.terminated_at, 'worker row does NOT have terminated_at set after signal_bound')

  // ── TEST 4: signal_done still terminates as before ──────────────────────
  console.log('TEST 4: signal_done still terminates the worker row (regression)')
  const doneTabId = 'test-tab-done-' + Date.now()
  const doneCred = 'cred-' + doneTabId
  coord._registerWorkerInternal({
    tab_id: doneTabId,
    task_id: 'test-task-4',
    tab_credential: doneCred,
    parent_conductor_tab_id: null,
    account_active_when_spawned: null,
  })

  await coord.signal_done({ task_id: 'test-task-4', result_summary: 'done regression test', terminate: true },
    { tab_id: doneTabId, tab_credential: doneCred })

  const doneFile = path.join(FAKE_COORD, 'workers', doneTabId + '.json')
  const row4 = JSON.parse(fs.readFileSync(doneFile, 'utf8'))
  assertTrue(!!row4.terminated_at, 'worker row HAS terminated_at after signal_done')

  // ── TEST 5: signal_bound return shape matches signal_done return shape ──
  console.log('TEST 5: signal_bound returns {message_id, created_at} (same shape as signal_done)')
  const r5 = await coord.signal_bound({ task_id: 'test-task-5' }, {})
  assertTrue(typeof r5.message_id === 'string', 'result has string message_id')
  assertTrue(typeof r5.created_at === 'string', 'result has string created_at')

  // ── TEST 6: signal_bound with ctx.tab_id picks up parent_conductor_tab_id ─
  console.log('TEST 6: signal_bound includes parent_conductor_tab_id from worker row when ctx.tab_id is set')
  const conductorTabId = 'conductor-tab-' + Date.now()
  const tab6 = 'test-tab-6-' + Date.now()
  coord._registerWorkerInternal({
    tab_id: tab6,
    task_id: 'test-task-6',
    tab_credential: 'cred-6',
    parent_conductor_tab_id: conductorTabId,
    account_active_when_spawned: null,
  })
  await coord.signal_bound({ task_id: 'test-task-6' }, { tab_id: tab6, tab_credential: 'cred-6' })

  const msgs6 = await peekAll('chat.conductor.inbox')
  const bound6 = msgs6.find(m => m.body && m.body.type === 'bound' && m.body.task_id === 'test-task-6')
  assertTrue(!!bound6, 'bound message for test-task-6 exists')
  assertEq(bound6 && bound6.body.parent_conductor_tab_id, conductorTabId,
    'parent_conductor_tab_id propagated into bound message body')

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
