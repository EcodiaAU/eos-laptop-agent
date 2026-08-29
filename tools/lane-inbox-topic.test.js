'use strict'
// Test for the 2026-08-29 tombstone fix in tools/coord.js inboxTopicFor.
//
// WHAT WAS BROKEN. inboxTopicFor keyed a chat's whole mailbox to its tab_id:
//     if (tab && tab !== 'conductor') return 'chat.' + tab + '.inbox'
// A tab_id dies with its tab, so a message sent to a finished chat was
// unreachable forever, and a SUCCESSOR working the same job started with an
// empty inbox while its predecessor's mail sat in a directory nothing would
// open again. 500 orphaned topic dirs on disk are that failure accumulated.
//
// THE FIX. Resolve through the WORK LANE first. The lane key strips the row
// name's trailing suffix, so the verify pass of a job inherits the mailbox of
// the pass that armed it. Tab-keyed addressing stays as the fallback, and the
// conductor topic is untouched because three live hooks hardcode it.
//
// The lane regex is a character-exact twin of the Postgres os_sched_lane_key,
// so the fixtures below are REAL (name, lane) pairs pulled from the live
// os_scheduled_tasks table, not invented. If the two ever disagree, the
// migration-147 trigger and this resolver would disagree about what a lane is.
//
// Run: node tools/lane-inbox-topic.test.js

const assert = require('assert')
const path = require('path')
const coord = require('./coord.js')

let failures = 0
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}

const topicFor = coord._inboxTopicFor
const laneKeyOf = coord._laneKeyOf

// Real rows from os_scheduled_tasks, with the lane key Postgres itself returned.
const FIXTURES = [
  ['cowork.daycrew-lane-S2-deploy-verify', 'cowork.daycrew-lane-s2'],
  ['cowork.daycrew-lane-S2-verify6', 'cowork.daycrew-lane-s2'],
  ['cowork.coexist-lane-P1-eventday-notify-and-401-window-verify', 'cowork.coexist-lane-p1'],
  ['cowork.hook-drift-lane-H1-heldout', 'cowork.hook-drift-lane-h1'],
  ['cowork.seedtree-lane-S1-drift-handoff', 'cowork.seedtree-lane-s1'],
  ['cowork.friend-connectors-lane-A1-recheck2', 'cowork.friend-connectors-lane-a1'],
  ['cowork.seedtree-lane-V1-coord-fix', 'cowork.seedtree-lane-v1'],
  ['cowork.gated-decisions-lane-T1-resurface', 'cowork.gated-decisions-lane-t1'],
]

console.log('lane key agrees with Postgres os_sched_lane_key on live rows:')
for (const [name, expected] of FIXTURES) {
  check(name + ' -> ' + expected, () => {
    assert.strictEqual(laneKeyOf(name), expected)
  })
}

console.log('\nnon-lane names yield no lane key (so they keep the legacy topic):')
for (const bad of [
  'continuity-advance-chain',            // a plain cron, no lane token
  'cowork.something-without-a-lane',     // cowork prefix but no -lane-
  'cowork.x-lane-noDigits',              // lane id must contain a digit
  '',
  null,
  undefined,
]) {
  check(JSON.stringify(bad) + ' -> null', () => {
    assert.strictEqual(laneKeyOf(bad), null)
  })
}

console.log('\nTHE INHERITANCE PROPERTY, which is the whole point:')
check('two passes of one job share a mailbox', () => {
  const armed = topicFor({ tab_id: 'tab_AAA', lane_name: 'cowork.daycrew-lane-S2-deploy-verify' })
  const successor = topicFor({ tab_id: 'tab_BBB', lane_name: 'cowork.daycrew-lane-S2-verify6' })
  assert.strictEqual(armed, successor,
    'a successor on the same lane must inherit the mailbox; got ' + armed + ' vs ' + successor)
  assert.strictEqual(armed, 'chat.lane.cowork.daycrew-lane-s2.inbox')
})
check('DIFFERENT lanes do NOT share a mailbox (the control)', () => {
  const a = topicFor({ tab_id: 'tab_AAA', lane_name: 'cowork.daycrew-lane-S2-x' })
  const b = topicFor({ tab_id: 'tab_AAA', lane_name: 'cowork.daycrew-lane-S4-x' })
  assert.notStrictEqual(a, b, 'S2 and S4 are different lanes and must not collide')
})

console.log('\nBACKWARD COMPATIBILITY, nothing that worked may break:')
check('conductor still resolves to chat.conductor.inbox (3 hooks hardcode it)', () => {
  assert.strictEqual(topicFor({}), 'chat.conductor.inbox')
  assert.strictEqual(topicFor({ tab_id: 'conductor' }), 'chat.conductor.inbox')
  assert.strictEqual(topicFor(null), 'chat.conductor.inbox')
})
check('conductor is NEVER lane-routed even if a lane is somehow passed', () => {
  assert.strictEqual(
    topicFor({ tab_id: 'conductor', lane_name: 'cowork.daycrew-lane-S2-x' }),
    'chat.conductor.inbox')
})
check('a worker with no lane keeps its legacy per-tab topic', () => {
  assert.strictEqual(topicFor({ tab_id: 'tab_XYZ' }), 'chat.tab_XYZ.inbox')
})
check('a worker whose lane name does not parse keeps the per-tab topic', () => {
  assert.strictEqual(topicFor({ tab_id: 'tab_XYZ', lane_name: 'not-a-lane' }), 'chat.tab_XYZ.inbox')
})

console.log('\nREGISTRY FALLBACK: an ordinary read_inbox with no args must still')
console.log('resolve to the lane mailbox, using what the worker registered with:')
check('registered lane_name drives the topic with no ctx.lane_name', () => {
  const tab = 'tab_lanetest_' + Date.now()
  coord._registerWorkerInternal({
    tab_id: tab,
    task_id: 'lane-inbox-test',
    tab_credential: 'cred-' + tab,
    lane_name: 'cowork.daycrew-lane-S2-verify6',
  })
  assert.strictEqual(topicFor({ tab_id: tab }), 'chat.lane.cowork.daycrew-lane-s2.inbox')
})
check('a worker registered WITHOUT a lane keeps its per-tab topic', () => {
  const tab = 'tab_nolane_' + Date.now()
  coord._registerWorkerInternal({
    tab_id: tab, task_id: 'no-lane', tab_credential: 'cred-' + tab,
  })
  assert.strictEqual(topicFor({ tab_id: tab }), 'chat.' + tab + '.inbox')
})

console.log('\nTHE ROUTE MUST AGREE WITH THE RESOLVER (it used to hardcode):')
check('register-worker source reports the resolver topic, not a built string', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'routes', 'comms.js'), 'utf8')
  assert.ok(!/inbox:\s*'chat\.'\s*\+\s*row\.tab_id/.test(src),
    'route still hand-builds the inbox address; it must call _inboxTopicFor')
  assert.ok(/coord\._inboxTopicFor\(/.test(src),
    'route must resolve through _inboxTopicFor so caller and callee agree')
})

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'))
process.exit(failures ? 1 : 0)
