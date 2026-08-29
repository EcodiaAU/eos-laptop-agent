'use strict'
// Failing-first harness for the 2026-08-29 send/receive address split.
//
// WHAT WAS BROKEN, and it was live. The coord mailbox became LANE-keyed on
// 2026-08-28: inboxTopicFor resolves a work-lane address so a successor on the
// same job inherits its predecessor's mail. That moved the RECEIVER. Every
// SENDER addressing a worker by tab_id or task_id went through
//     function addressForWorker(tabId) { return 'chat.' + tabId + '.inbox' }
// which kept writing to the per-tab topic. So a reply to a lane-bearing worker
// landed in a mailbox that worker no longer reads, and the send returned
// ok:true / delivered:false, which reads as "queued, will be seen later".
//
// Measured on a live registry row before the fix: message 427fab8b sent to
// tab_lanetest_1788011002843 landed in chat.tab_lanetest_1788011002843.inbox,
// while that worker's own read path (peek_inbox with identity only, no topic
// argument) returned chat.lane.cowork.daycrew-lane-s2.inbox and did NOT contain
// it. Sender and receiver each internally consistent, disagreeing with each
// other, which is worse than either address alone.
//
// This is the THIRD recurrence of one defect class: routes/comms.js built the
// address by hand (fixed 2026-08-28), both composeBrief headers did (fixed
// 2026-08-29 earlier today), and addressForWorker did. Hence the rule the fix
// encodes: nothing builds this string by hand, inboxTopicFor is the one opinion.
//
// Cases 1 and 4 FAIL against the pre-fix tree. Everything else is a control:
// they pass on BOTH sides and are what prove the suite discriminates rather
// than merely being red.
//
// Run: node tools/lane-send-address-agreement.test.js

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// HERMETIC REGISTRY, and this is load-bearing rather than tidy. coord.js runs
// loadFromDisk() at require time, so without this the suite inherits the LIVE
// fleet's worker rows. First run did exactly that: a real worker on
// cowork.daycrew-lane-S2-verify6 was holding the very lane under test, so three
// cases failed with lane_ambiguous_holder and one task_id lookup found two hits.
// A suite whose verdict depends on which workers happen to be alive is not a
// test, and it would have been RED here and GREEN at 3am for no code reason.
process.env.COORD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-lane-send-'))

const coord = require('./coord.js')

let failures = 0
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}
async function acheck(name, fn) {
  try { await fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}

const canonical = coord._canonicalAddress
const topicFor = coord._inboxTopicFor
const resolveTarget = coord._resolveLiveTargetTab

const LANE = 'cowork.daycrew-lane-S2-deploy-verify'
const LANE_KEY_TOPIC = 'chat.lane.cowork.daycrew-lane-s2.inbox'

// task ids are uuid-shaped on purpose: _canonicalAddress gates its task_id
// branch on /^[0-9a-fA-F-]{16,}$/, so a friendly 'task-foo' silently returns
// null and the case reads as a routing failure rather than a bad fixture.
const TASK = {
  tab_LANEA: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  tab_NOLANE: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  tab_LANEB: 'cccccccc-3333-4333-8333-cccccccccccc',
}
function reg(tab_id, opts) {
  coord._registerWorkerInternal(Object.assign({
    tab_id: tab_id, task_id: TASK[tab_id], tab_credential: 'cred-' + tab_id,
  }, opts || {}))
}

;(async function main() {
  console.log('THE SENDER MUST LAND WHERE THE RECEIVER READS:')

  reg('tab_LANEA', { lane_name: LANE })
  reg('tab_NOLANE', {})

  check('a send addressed by tab_id targets the LANE mailbox for a lane worker', () => {
    const sent = canonical('tab_LANEA')
    const read = topicFor({ tab_id: 'tab_LANEA' })
    assert.strictEqual(sent, LANE_KEY_TOPIC,
      'sender must resolve through inboxTopicFor, not build chat.<tab>.inbox; got ' + sent)
    assert.strictEqual(sent, read,
      'THE WHOLE BUG: sender ' + sent + ' vs receiver ' + read)
  })

  check('CONTROL: a worker with no lane keeps the per-tab address on BOTH sides', () => {
    const sent = canonical('tab_NOLANE')
    const read = topicFor({ tab_id: 'tab_NOLANE' })
    assert.strictEqual(sent, 'chat.tab_NOLANE.inbox', 'pre-lane addressing must be byte-identical')
    assert.strictEqual(sent, read)
  })

  check('CONTROL: addressing by task_id agrees too (the brief hands out a task_id)', () => {
    assert.strictEqual(canonical(TASK.tab_LANEA), LANE_KEY_TOPIC)
  })

  check('ESCAPE HATCH: an explicit chat.<tab>.inbox is still returned verbatim', () => {
    // Reaching ONE tab rather than its work lane must stay expressible.
    assert.strictEqual(canonical('chat.tab_LANEA.inbox'), 'chat.tab_LANEA.inbox')
  })

  check('CONTROL: the conductor address is untouched (three live hooks hardcode it)', () => {
    assert.strictEqual(canonical('conductor'), 'chat.conductor.inbox')
    assert.strictEqual(topicFor({ tab_id: 'conductor', lane_name: LANE }), 'chat.conductor.inbox')
  })

  console.log('\nA LANE TOPIC MUST STILL REACH A LIVE TAB (or the wake half dies silently):')

  const TABS = [
    { label: '[EOS-W-LANEA] daycrew s2', viewColumn: 1, index: 3, tabId: 'ttab_a' },  // exact match to the stored sentinel
    { label: 'some human chat', viewColumn: 1, index: 4, tabId: 'ttab_h' },
  ]
  coord._setChatInject({ async listChatTabs() { return TABS } })
  coord.setWorkerTabHandle('tab_LANEA', { sentinel_prefix: '[EOS-W-LANEA] daycrew s2', viewColumn: 1, index: 3 })

  await acheck('a lane topic resolves to the single live worker holding that lane', async () => {
    const r = await resolveTarget(LANE_KEY_TOPIC)
    assert.ok(r && r.ok, 'lane topic must resolve to a live tab, got ' + JSON.stringify(r))
    assert.strictEqual(r.index, 3, 'resolved to the wrong tab: ' + JSON.stringify(r))
  })

  await acheck('REFUSES when two live tabs hold the same lane (fail safe to the shared inbox)', async () => {
    // A predecessor still closing while its successor boots is a real state, and
    // both read the same lane mailbox, so queueing loses nothing.
    reg('tab_LANEB', { lane_name: 'cowork.daycrew-lane-S2-verify6' })
    const r = await resolveTarget(LANE_KEY_TOPIC)
    assert.ok(r && !r.ok, 'ambiguous lane must NOT pick one; got ' + JSON.stringify(r))
    assert.strictEqual(r.reason, 'lane_ambiguous_holder')
  })

  await acheck('a TERMINATED holder never makes a live successor ambiguous', async () => {
    // Closed-tab identity is never inherited, the same rule the worker branch uses.
    // signal_done reads the caller's identity from its ctx argument, not from
    // params: `if (ctx.tab_id && workers.has(ctx.tab_id))` is what stamps
    // terminated_at. Passing tab_id in params alone leaves the row alive and the
    // case fails as lane_ambiguous_holder, which looks like a resolver bug.
    await coord.signal_done(
      { task_id: TASK.tab_LANEB, status: 'success', terminate: true },
      { tab_id: 'tab_LANEB', tab_credential: 'cred-tab_LANEB' }
    )
    const r = await resolveTarget(LANE_KEY_TOPIC)
    assert.ok(r && r.ok, 'a dead predecessor must be excluded before counting; got ' + JSON.stringify(r))
    assert.strictEqual(r.index, 3)
  })

  await acheck('a lane nobody holds refuses rather than guessing', async () => {
    const r = await resolveTarget('chat.lane.cowork.nobody-lane-z9.inbox')
    assert.ok(r && !r.ok)
    assert.strictEqual(r.reason, 'lane_no_live_holder')
  })

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
  process.exit(failures === 0 ? 0 : 1)
})()
