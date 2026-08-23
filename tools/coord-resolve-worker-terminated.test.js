'use strict'

// Regression test for the 2026-08-23 worker misroute.
//
// A reply addressed to a FINISHED worker's tab id was injected into a DIFFERENT,
// LIVE worker in the same arc, and reported delivered:true kind:'worker'. It only
// surfaced because the receiving worker refused credit for work it had not done.
//
// Mechanism: a terminated worker's on-disk row is reaped (WORKERS_DIR unlink) but
// its in-memory `workers` entry survives with terminated_at set, and
// loadWorkerRegistry's hot path serves it regardless. The worker-branch label
// fallback is truncation-aware, so the dead worker's stored label prefix-matches a
// live sibling's truncated label and resolution lands on a stranger.
//
// Every refusal assertion here is PAIRED with a positive control on the identical
// setup, differing only in the one variable under test. A refusal on a setup that
// could never have resolved anyway proves nothing. Doctrine:
// a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-resolve-worker-terminated.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-wterm-test-'))
process.env.COORD_ROOT = tmpRoot

const coord = require('./coord')
const chatInject = require('./chat-inject')
const realList = chatInject.listChatTabs

// The live tab belonging to the VERIFY worker. Claude Code truncates it, which is
// exactly what lets a dead sibling's stored label prefix-match it.
const LIVE_LABEL = '[grant strip verify and …'
const STORED_FULL = '[grant strip verify and outward probe tranche]'
const TABS = [{ label: LIVE_LABEL, viewColumn: 1, index: 0 }]

async function withTabs(fn) {
  chatInject.listChatTabs = async () => TABS
  try { return await fn() } finally { chatInject.listChatTabs = realList }
}

let passed = 0
function ok(name, cond) {
  if (!cond) { console.error('FAIL: ' + name); process.exitCode = 1 }
  else { passed++; console.log('ok - ' + name) }
}

function mkWorker(tab_id) {
  coord._registerWorkerInternal({ tab_id: tab_id, task_id: 'task-' + tab_id, tab_credential: 'cred-' + tab_id })
  coord.setWorkerTabHandle(tab_id, { label: STORED_FULL, viewColumn: 1, index: 0 })
}

;(async () => {
  await withTabs(async () => {
    // POSITIVE CONTROL. A live worker whose stored label prefix-matches the live
    // tab MUST resolve. If this fails, every refusal below is vacuous.
    mkWorker('tab_live_owner')
    const live = await coord._resolveLiveTargetTab('chat.tab_live_owner.inbox')
    ok('CONTROL: a live worker resolves to its own tab', !!(live && live.ok === true))

    // THE BUG. Same worker, same stored label, same live tab. Only terminated_at
    // differs. Before the fix this resolved ok:true and injected into the stranger.
    const w = coord.loadWorkerRegistry('tab_live_owner')
    w.terminated_at = new Date().toISOString()
    const dead = await coord._resolveLiveTargetTab('chat.tab_live_owner.inbox')
    ok('terminated worker REFUSES instead of inheriting the live tab',
       !!(dead && dead.ok === false && dead.reason === 'worker_terminated'))
    ok('the refusal is not a silent success', !(dead && dead.ok))
  })

  await withTabs(async () => {
    // OWNERSHIP GUARD. A sibling whose stored label matches the tab a DIFFERENT
    // live worker owns must not be handed that tab.
    mkWorker('tab_owner_b')
    mkWorker('tab_ghost_b')
    const r = await coord._resolveLiveTargetTab('chat.tab_ghost_b.inbox')
    ok('a tab owned by another live worker is refused, not inherited',
       !!(r && r.ok === false && r.reason === 'worker_tab_owned_by_other'))
    ok('the refusal names the real owner', !!(r && r.owner))
  })

  console.log('\n' + passed + ' assertions passed')
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
})().catch((e) => { console.error(e); process.exitCode = 1 })
