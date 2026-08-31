'use strict'

// Unit tests for the SLOT-BROADCAST auto_type refusal (2026-08-31).
//
// Reproduces the live misroute: four cron workers signalled done between
// 11:33:25Z and 11:34:54Z, each posting a `worker_report` to the singleton
// `chat.conductor.inbox`, and the wake ladder auto-typed them as turns into a
// chat that had dispatched none of them. All 25 live worker rows carried
// parent_session=NULL, which is CORRECT for a scheduler-leased row (there is no
// dispatching chat), and scheduler.js:2011 already states crons are meant to be
// inbox-only. The 2026-08-28 refusal to guess was enforced in message_chat's
// ADDRESSING path only; signal_done reaches the slot through send_message and
// never meets it, so the guard now sits at the wake site where every path
// converges.
//
// Proves: a worker's slot-addressed message is refused auto_type BY THE GUARD
// (not by the kill switch); a NON-worker's identical message still reaches the
// injection tier, so the guard is scoped rather than a blanket wake kill; a
// worker WITH a recorded parent is still a broadcast when it addresses the slot;
// and a worker's message to a session address is not a broadcast at all.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-slot-broadcast-no-autotype.test.js

process.env.COORD_DISABLE_SWEEP = '1'
process.env.COORD_CHAT_INJECT = '0'   // no GUI in a unit test
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-slot-broadcast-test-'))
process.env.COORD_ROOT = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'chat-tabs'), { recursive: true })

const coord = require('./coord')
const WAKE_STATE = path.join(tmpRoot, 'wake_state.json')

let passed = 0, failed = 0
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')) }
}

const PARENT = 'dbf03de2-f9cb-4f9b-a6d5-181da825d40b'

// rate_limit_ms 0: consecutive sends in a test must each be allowed to reach the
// ladder, or case 2 would report 'rate_limited' and look like a pass for the
// wrong reason.
coord.register_conductor({ tab_id: 'conductor', title_match: 'Coord messaging is STILL', ide: 'stable' })
coord.set_wake_policy({ mode: 'auto_type', notify_types: ['*'], rate_limit_ms: 0 })

// Read the tier verdict the ladder actually recorded. record() is called from
// async toast continuations too, so poll until auto_type is stamped.
async function autoTypeVerdict() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(WAKE_STATE, 'utf8'))
      if (j && j.tiers && j.tiers.auto_type) return j.tiers.auto_type
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}
function clearWake() { try { fs.unlinkSync(WAKE_STATE) } catch (e) {} }

async function main() {
  coord._registerWorkerInternal({
    tab_id: 'tab_cron_worker', task_id: 'tcron', tab_credential: 'c1',
    parent_conductor_tab_id: 'conductor', parent_session: null, lane_name: 'bank-feed-staleness-canary',
  })
  coord._registerWorkerInternal({
    tab_id: 'tab_parented_worker', task_id: 'tpar', tab_credential: 'c2',
    parent_conductor_tab_id: 'conductor', parent_session: PARENT,
  })

  // --- case 1: THE DEFECT. Parentless worker broadcasts to the slot. ---------
  clearWake()
  await coord.send_message(
    { to: 'chat.conductor.inbox', body: { type: 'worker_report', task_id: 'tcron', status: 'success', result_summary: 'verified-close' } },
    { tab_id: 'tab_cron_worker' })
  const v1 = await autoTypeVerdict()
  ok('worker slot-broadcast is refused auto_type', !!v1 && v1.ok === false, v1)
  ok('refusal is BY THE GUARD, not the kill switch',
    !!v1 && v1.reason === 'slot_broadcast_not_injected', v1 && v1.reason)
  ok('refusal names the worker so it is diagnosable, not silent',
    !!v1 && v1.from_worker === 'tab_cron_worker' && v1.lane_name === 'bank-feed-staleness-canary', v1)

  // --- case 2: THE CONTROL that makes case 1 mean anything. ------------------
  // Same address, same body type, sender is NOT a worker. If this ALSO reported
  // slot_broadcast_not_injected the guard would be a blanket wake kill and case
  // 1 would prove nothing. It must fall through to the injection tier and be
  // stopped there by COORD_CHAT_INJECT=0 instead.
  clearWake()
  await coord.send_message(
    { to: 'chat.conductor.inbox', body: { type: 'worker_report', task_id: 'tcron', status: 'success', result_summary: 'same body, non-worker sender' } },
    { tab_id: 'chat_peer_not_a_worker' })
  const v2 = await autoTypeVerdict()
  ok('non-worker sender still REACHES the injection tier',
    !!v2 && v2.reason !== 'slot_broadcast_not_injected', v2)
  ok('and is stopped only by the kill switch, proving the path was live',
    !!v2 && v2.darwin_inject === 'inject_disabled', v2)

  // --- case 3: a recorded parent does not make a slot cast an identity ------
  clearWake()
  await coord.send_message(
    { to: 'chat.conductor.inbox', body: { type: 'worker_report', task_id: 'tpar', status: 'success' } },
    { tab_id: 'tab_parented_worker' })
  const v3 = await autoTypeVerdict()
  ok('parented worker addressing the SLOT is still a broadcast',
    !!v3 && v3.reason === 'slot_broadcast_not_injected', v3)
  ok('and the recorded parent is reported so the misaddressing is visible',
    !!v3 && v3.parent_session === PARENT, v3 && v3.parent_session)

  // --- case 4: a worker addressing an IDENTITY is not a broadcast -----------
  // chat.session:*.inbox is not a wake topic, so the ladder records nothing at
  // all. The discriminating assertion is that no slot-broadcast verdict appears,
  // NOT merely that the file is absent.
  clearWake()
  await coord.send_message(
    { to: 'chat.session:' + PARENT + '.inbox', body: { type: 'worker_report', task_id: 'tpar', status: 'success' } },
    { tab_id: 'tab_parented_worker' })
  await new Promise((r) => setTimeout(r, 300))
  let v4 = null
  try { v4 = JSON.parse(fs.readFileSync(WAKE_STATE, 'utf8')).tiers.auto_type } catch (e) {}
  ok('session-addressed worker mail is not classified as a slot broadcast',
    !(v4 && v4.reason === 'slot_broadcast_not_injected'), v4)

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
