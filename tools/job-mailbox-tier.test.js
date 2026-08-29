'use strict'
// The 2026-08-30 JOB tier: a durable mailbox for a row with a stable name and no
// lane token. Closes the last hole in coord addressing (status_board be6d894f).
//
// WHY. Lane keying reached 296 of 313 one-shot rows armed in 24h and 1 of 77
// ACTIVE crons. A cron is the canonical successor-on-the-same-job: today's fire
// and tomorrow's fire are the same work forever, and it was the population
// inheriting nothing, because each fire registered a fresh tab_id and fell back
// to per-tab addressing. Mail left for a recurring job died with whichever tab
// was running when it landed.
//
// Run: node tools/job-mailbox-tier.test.js

const assert = require('assert')
const fs = require('fs'), os = require('os'), path = require('path')
// Hermetic: coord.js loads the live registry from disk at require time, and a
// suite whose verdict depends on which workers happen to be alive is not a test.
process.env.COORD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-job-tier-'))
const coord = require('./coord.js')

let failures = 0
function check(n, fn) { try { fn(); console.log('  PASS  ' + n) } catch (e) { failures++; console.log('  FAIL  ' + n + '\n        ' + e.message) } }
async function acheck(n, fn) { try { await fn(); console.log('  PASS  ' + n) } catch (e) { failures++; console.log('  FAIL  ' + n + '\n        ' + e.message) } }

const topicFor = coord._inboxTopicFor
const jobKeyOf = coord._jobKeyOf
const canonical = coord._canonicalAddress
const resolveTarget = coord._resolveLiveTargetTab

function reg(tab, opts) {
  coord._registerWorkerInternal(Object.assign({ tab_id: tab, task_id: 't-' + tab, tab_credential: 'c-' + tab }, opts || {}))
}

;(async function main() {
  console.log('a cron gets a mailbox that outlives the fire that opened it:')

  // REAL cron names, read from the live os_scheduled_tasks population.
  reg('tab_CRON_A', { lane_name: 'gmail-inbox-poll' })
  reg('tab_CRON_B', { lane_name: 'GMAIL-Inbox-Poll' })   // tomorrow's fire, different tab

  check('two fires of the same cron share one mailbox', () => {
    const a = topicFor({ tab_id: 'tab_CRON_A' })
    const b = topicFor({ tab_id: 'tab_CRON_B' })
    assert.strictEqual(a, 'chat.job.gmail-inbox-poll.inbox', 'got ' + a)
    assert.strictEqual(a, b, 'a cron must inherit across fires; got ' + a + ' vs ' + b)
  })

  check('the sender agrees with the reader (the split fixed earlier today)', () => {
    assert.strictEqual(canonical('tab_CRON_A'), topicFor({ tab_id: 'tab_CRON_A' }))
  })

  console.log('\nordering and controls, so nothing that resolved before moves:')

  check('CONTROL: a LANE row still resolves to its lane, not its job key', () => {
    reg('tab_LANE', { lane_name: 'cowork.daycrew-lane-S2-deploy-verify' })
    assert.strictEqual(topicFor({ tab_id: 'tab_LANE' }), 'chat.lane.cowork.daycrew-lane-s2.inbox')
  })

  check('CONTROL: the conductor topic is untouched (three live hooks hardcode it)', () => {
    assert.strictEqual(topicFor({ tab_id: 'conductor', lane_name: 'gmail-inbox-poll' }), 'chat.conductor.inbox')
    assert.strictEqual(canonical('conductor'), 'chat.conductor.inbox')
  })

  check('CONTROL: a worker with NO name at all keeps the per-tab address', () => {
    reg('tab_NONAME', {})
    assert.strictEqual(topicFor({ tab_id: 'tab_NONAME' }), 'chat.tab_NONAME.inbox')
  })

  check('ESCAPE HATCH: an explicit chat.<tab>.inbox is still returned verbatim', () => {
    assert.strictEqual(canonical('chat.tab_CRON_A.inbox'), 'chat.tab_CRON_A.inbox')
  })

  check('the key is sanitised, because a topic becomes a directory name', () => {
    assert.strictEqual(jobKeyOf('World Model/Pulse!!'), 'world-model-pulse')
    assert.strictEqual(jobKeyOf('  '), null)
    assert.strictEqual(jobKeyOf(null), null)
    assert.strictEqual(jobKeyOf('cowork.world-model-pulse'), 'cowork.world-model-pulse')
  })

  console.log('\nthe reverse map, or the durable half works while the wake half dies:')

  const TABS = [{ label: '[EOS-W-CRONA] gmail inbox poll', viewColumn: 1, index: 2, tabId: 'ttab_c' }]
  coord._setChatInject({ async listChatTabs() { return TABS } })
  coord.setWorkerTabHandle('tab_CRON_A', { sentinel_prefix: '[EOS-W-CRONA] gmail inbox poll', viewColumn: 1, index: 2 })

  await acheck('a job topic resolves to the single live holder', async () => {
    // tab_CRON_B shares the job key, so retire it first: two live fires of one
    // cron is a real state and must refuse, which the next case pins.
    await coord.signal_done({ task_id: 't-tab_CRON_B', status: 'success', terminate: true },
      { tab_id: 'tab_CRON_B', tab_credential: 'c-tab_CRON_B' })
    const r = await resolveTarget('chat.job.gmail-inbox-poll.inbox')
    assert.ok(r && r.ok, 'expected a resolution, got ' + JSON.stringify(r))
    assert.strictEqual(r.index, 2)
  })

  await acheck('two live fires of one cron REFUSE rather than guess', async () => {
    reg('tab_CRON_C', { lane_name: 'gmail-inbox-poll' })
    const r = await resolveTarget('chat.job.gmail-inbox-poll.inbox')
    assert.ok(r && !r.ok, 'ambiguous job must not pick one; got ' + JSON.stringify(r))
    assert.strictEqual(r.reason, 'job_ambiguous_holder')
  })

  await acheck('a job nobody holds refuses rather than guessing', async () => {
    const r = await resolveTarget('chat.job.nobody-runs-this.inbox')
    assert.ok(r && !r.ok)
    assert.strictEqual(r.reason, 'job_no_live_holder')
  })

  await acheck('a LANE-bearing worker never answers to a job key (one address each)', async () => {
    const r = await resolveTarget('chat.job.cowork.daycrew-lane-s2-deploy-verify.inbox')
    assert.ok(r && !r.ok, 'a lane worker must not be reachable by its job key too')
    assert.strictEqual(r.reason, 'job_no_live_holder')
  })

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
  process.exit(failures === 0 ? 0 : 1)
})()
