'use strict'

// Unit tests for the worker -> `conductor` parent-session rewrite (2026-08-28).
//
// Reproduces the PROVEN misroute: worker tab_1787806439688_403f2ce5 (coexist
// lane Q1) addressed `conductor` at 01:12:23Z. Its dispatching chat was session
// dbf03de2, but chat ebad5adf had taken a user turn 62s earlier and therefore
// held the single global conductor slot, so the injected turn landed in ebad5adf
// and the parent never saw it. The GUI injection chain was correct throughout:
// it delivered exactly where resolution pointed. `conductor` is not an identity.
//
// Proves: a worker with a recorded parent_session is rewritten to that chat's
// stable address; a worker with NO recorded parent is queued rather than
// injected into whoever holds the slot; a non-worker sender is untouched; and a
// terminated worker row does not rewrite.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-worker-parent-session.test.js

process.env.COORD_DISABLE_SWEEP = '1'
process.env.COORD_CHAT_INJECT = '0'   // no GUI in a unit test; delivery is asserted on the address
const os = require('os')
const path = require('path')
const fs = require('fs')
const assert = require('assert')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-parent-session-test-'))
process.env.COORD_ROOT = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'chat-tabs'), { recursive: true })

const coord = require('./coord')

const PARENT = 'dbf03de2-f9cb-4f9b-a6d5-181da825d40b'   // the chat that dispatched
const SLOT_HOLDER = 'ebad5adf-6dfd-4354-b879-7a2811759514'  // the chat holding `conductor`

let passed = 0, failed = 0
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ' + JSON.stringify(extra) : '')) }
}

// The conductor slot is held by a DIFFERENT chat than the one that dispatched -
// exactly the live state at 01:12:23Z.
coord.register_conductor({ tab_id: 'conductor', title_match: 'Ryan sent me this yester…', ide: 'stable' })

async function main() {
  // --- case 1: worker WITH a recorded parent_session -------------------------
  coord._registerWorkerInternal({
    tab_id: 'tab_parent_known', task_id: 't1', tab_credential: 'c1',
    parent_conductor_tab_id: 'conductor', parent_session: PARENT,
  })
  const r1 = await coord.message_chat(
    { to: 'conductor', text: 'lane Q1 addendum: third file to commit' },
    { tab_id: 'tab_parent_known' }
  )
  ok('worker->conductor rewrites to its parent session address',
    r1.ok && r1.to_address === 'chat.session:' + PARENT + '.inbox', r1)
  ok('rewrite is reported to the caller, never silent',
    !!(r1.parent_rewrite && r1.parent_rewrite.reason === 'worker_parent_session'), r1.parent_rewrite)
  // The discriminating assertion: the address must be ANCHORED to a specific
  // session, not the singleton. A bare "does not contain SLOT_HOLDER" check
  // passes pre-fix too (chat.conductor.inbox names no session), so it proves
  // nothing - the singleton only becomes the slot holder later, at inject time.
  ok('the address is session-anchored, so no later slot holder can capture it',
    /^chat\.session:[0-9a-f-]{36}\.inbox$/.test(r1.to_address)
      && r1.to_address !== 'chat.conductor.inbox', r1.to_address)

  // --- case 2: worker with NO recorded parent -> queue, never guess ----------
  coord._registerWorkerInternal({
    tab_id: 'tab_parent_unknown', task_id: 't2', tab_credential: 'c2',
    parent_conductor_tab_id: 'conductor',
  })
  const r2 = await coord.message_chat(
    { to: 'conductor', text: 'orphan worker report' },
    { tab_id: 'tab_parent_unknown' }
  )
  ok('unknown-parent worker still addresses the conductor inbox (durable)',
    r2.ok && r2.to_address === 'chat.conductor.inbox', r2.to_address)
  ok('unknown-parent worker is QUEUED, not injected into the slot holder',
    r2.delivered === false && r2.parent_rewrite
      && r2.parent_rewrite.reason === 'worker_parent_unknown_queue_only', r2.parent_rewrite)

  // --- case 3: a NON-worker sender is untouched ------------------------------
  const r3 = await coord.message_chat(
    { to: 'conductor', text: 'peer chat to conductor' },
    {}
  )
  ok('non-worker sender to conductor is unchanged',
    r3.ok && r3.to_address === 'chat.conductor.inbox' && !r3.parent_rewrite, r3)

  // --- case 4: a TERMINATED worker row does not rewrite ----------------------
  coord._registerWorkerInternal({
    tab_id: 'tab_dead', task_id: 't4', tab_credential: 'c4', parent_session: PARENT,
  })
  const row = coord._workersMap().get('tab_dead')
  assert(row, 'test setup: tab_dead row must exist, else this case proves nothing')
  assert.strictEqual(row.parent_session, PARENT, 'test setup: tab_dead must carry a parent to make termination the discriminator')
  row.terminated_at = new Date().toISOString()
  const r4 = await coord.message_chat(
    { to: 'conductor', text: 'from a dead worker' },
    { tab_id: 'tab_dead' }
  )
  ok('terminated worker does not rewrite (its parent claim is stale)',
    r4.to_address === 'chat.conductor.inbox' && !r4.parent_rewrite, r4.to_address)

  // --- case 4b: resolve_only must report the SAME address the send would use --
  // A dry-run that answers a different question than the real send is worse than
  // no dry-run. Caught live 2026-08-28: the rewrite sat BELOW the resolve_only
  // early return, so `resolve_only` told a worker its `conductor` message would
  // go to chat.conductor.inbox while the real send rewrote it to the parent.
  const dry = await coord.message_chat(
    { to: 'conductor', text: 'x', resolve_only: true },
    { tab_id: 'tab_parent_known' }
  )
  const wet = await coord.message_chat(
    { to: 'conductor', text: 'x' },
    { tab_id: 'tab_parent_known' }
  )
  ok('resolve_only reports the parent address, not the pre-rewrite slot',
    dry.would_send_to === 'chat.session:' + PARENT + '.inbox', dry.would_send_to)
  ok('resolve_only agrees with the real send',
    dry.would_send_to === wet.to_address, { dry: dry.would_send_to, wet: wet.to_address })

  // --- case 5: an explicit session: target is never overridden ---------------
  const r5 = await coord.message_chat(
    { to: 'session:' + SLOT_HOLDER, text: 'deliberately to that chat' },
    { tab_id: 'tab_parent_known' }
  )
  ok('an explicit session: target is honoured, not rewritten to the parent',
    r5.ok && r5.to_address === 'chat.session:' + SLOT_HOLDER + '.inbox' && !r5.parent_rewrite, r5.to_address)

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
