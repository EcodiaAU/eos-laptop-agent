'use strict'

// Regression test for the recurring-cron worker-tab leak (2026-08-29).
//
// THE DEFECT. close_my_tab and kill_worker resolved a worker's own IDE tab
// through three handles and a recurring cron breaks all three:
//   1. tabIndex captured at spawn. Volatile; measured shifting 13 -> 15 inside
//      three minutes as sibling tabs opened.
//   2. label_at_spawn, stored as the literal "Claude Code" and flagged
//      captured_label_is_provisional. Never an identity.
//   3. sentinel_prefix + an autotitle_fingerprint DERIVED FROM THE BRIEF TEXT.
//      A cron re-fires ONE os_scheduled_tasks row with a byte-identical brief,
//      so fire N and fire N+1 carry the same sentinel and the same fingerprint
//      and Claude Code summarises both to the same tab title. The fingerprint is
//      GUARANTEED to collide with every prior fire. Not unlucky, structural.
// The resolver correctly REFUSES on ambiguity rather than closing a stranger, so
// from fire 2 onward every recurring-cron worker leaks its tab forever.
//
// THE FIX. The IDE bridge already mints a stable per-tab id (ttab_...,
// cursor-preview-extension/ide-bridge.js assignStableTabIds) that survives both
// a reorder and a retitle. Coord captures it at signal_bound and resolves the
// close on that EXACT id, with no fallthrough to index / label / fingerprint.
//
// Every refusal assertion below is PAIRED with a positive control on the same
// fixture, differing only in the variable under test. A refusal on a setup that
// could never have resolved anyway proves nothing. Doctrine:
// a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-stable-tab-id-close.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-stable-tabid-'))
process.env.COORD_ROOT = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'conductors'), { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'chat-tabs'), { recursive: true })
fs.writeFileSync(
  path.join(tmpRoot, 'conductors', 'current.json'),
  JSON.stringify({ tab_id: 'conductor', ide_bridge_port: 65535, title_match: 'CONDUCTOR OWN CHAT' })
)

const coord = require('./coord')
const ide = require('./ide')

const CC = 'mainThreadWebview-claudeVSCodePanel'

// The cron shape. One os_scheduled_tasks row, two fires, byte-identical brief.
const SENTINEL = '[68d5 pattern binding ttl sweep daily]'
const FINGERPRINT = { v: 1, tokens: ['pattern', 'binding', 'ttl', 'sweep', 'daily'] }
// Claude Code summarises the identical brief to the identical title on both
// fires. This is what makes the fingerprint tier structurally ambiguous.
const AUTOTITLE = 'Pattern binding TTL sweep…'

let LIVE_TABS = []
const closeCalls = []
const realTabs = ide.tabs
const realClose = ide.tabs_close

ide.tabs = async () => ({
  groups: [{
    viewColumn: 1,
    isActive: true,
    tabs: LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t)),
  }],
})
ide.tabs_close = async (req) => {
  closeCalls.push(req)
  const group = LIVE_TABS
  const at = typeof req.tabIndex === 'number' ? group[req.tabIndex] : null
  if (at && req.exactLabel && at.label !== req.exactLabel) {
    return { closed: 0, matched: 0, refused: 'exactLabel_mismatch' }
  }
  return { closed: at ? 1 : 0, matched: at ? 1 : 0 }
}

let fails = 0
function ok(name, cond, extra) {
  if (cond) { console.log('  PASS: ' + name) }
  else { console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); fails++ }
}

function mkCronWorker(tab_id, spawnIndex) {
  coord._registerWorkerInternal({ tab_id: tab_id, task_id: 'ttl-sweep-row', tab_credential: 'cred-' + tab_id })
  coord.setWorkerTabHandle(tab_id, {
    sentinel_prefix: SENTINEL,
    viewColumn: 1,
    viewType: CC,
    label_at_spawn: 'Claude Code',
    tabIndex: spawnIndex,
    autotitle_fingerprint: FINGERPRINT,
    captured_via: 'bridge_chat_send_message',
    captured_label_is_provisional: true,
  })
}

function setTabId(tab_id, ttab) {
  const w = coord.loadWorkerRegistry(tab_id)
  w.tab_handle.tabId = ttab
  w.tab_handle.tabId_captured_at = new Date().toISOString()
  w.tab_handle.tabId_captured_label = SENTINEL
}

;(async () => {
  console.log('\n== Part 1: the defect. Two fires of one cron, identical sentinel + fingerprint ==')

  // Fire 1's corpse tab is still open; fire 2 is the live worker. Claude Code has
  // retitled BOTH away from the sentinel to the same brief summary.
  LIVE_TABS = [
    { tabId: 'ttab_fire1_1_1', label: AUTOTITLE },
    { tabId: 'ttab_fire2_1_1', label: AUTOTITLE },
  ]
  mkCronWorker('tab_cron_fire1', 0)
  mkCronWorker('tab_cron_fire2', 1)

  closeCalls.length = 0
  const noId = await coord.close_my_tab({}, { tab_id: 'tab_cron_fire2' })
  ok('CONTROL (failing-first): with no stored tabId the cron fixture REFUSES',
    noId.closed === false && !!noId.refused, JSON.stringify(noId))
  ok('CONTROL: the refusal names the fingerprint as ambiguous, not merely absent',
    /fp=ambiguous/.test(String(noId.refused || '')), String(noId.refused))
  ok('CONTROL: nothing was closed on the ambiguous fixture', closeCalls.length === 0)

  console.log('\n== Part 2: the fix. Same fixture, stable tabId stored ==')
  setTabId('tab_cron_fire1', 'ttab_fire1_1_1')
  setTabId('tab_cron_fire2', 'ttab_fire2_1_1')

  closeCalls.length = 0
  const r2 = await coord.close_my_tab({}, { tab_id: 'tab_cron_fire2' })
  ok('fire 2 closes its OWN tab through the stable id', r2.closed === true, JSON.stringify(r2))
  ok('fire 2 reports the stable_tab_id strategy',
    /^stable_tab_id:ttab_fire2_1_1$/.test(String(r2.strategy || '')), String(r2.strategy))
  ok('fire 2 targeted index 1, its own live slot',
    closeCalls.length === 1 && closeCalls[0].tabIndex === 1, JSON.stringify(closeCalls))
  ok('fire 2 sent its own live label as the race guard',
    closeCalls.length === 1 && closeCalls[0].exactLabel === AUTOTITLE)

  closeCalls.length = 0
  const r1 = await coord.close_my_tab({}, { tab_id: 'tab_cron_fire1' })
  ok('fire 1 closes its OWN tab, the sibling with the identical title',
    r1.closed === true && /^stable_tab_id:ttab_fire1_1_1$/.test(String(r1.strategy || '')), JSON.stringify(r1))
  ok('fire 1 targeted index 0, not fire 2 slot',
    closeCalls.length === 1 && closeCalls[0].tabIndex === 0, JSON.stringify(closeCalls))

  console.log('\n== Part 3: the id survives a reorder, which is what tabIndex cannot ==')
  // Three sibling tabs opened below, so every stored spawn index is now wrong.
  LIVE_TABS = [
    { tabId: 'ttab_other_a', label: 'Some human chat' },
    { tabId: 'ttab_other_b', label: 'Another human chat' },
    { tabId: 'ttab_fire1_1_1', label: AUTOTITLE },
    { tabId: 'ttab_fire2_1_1', label: AUTOTITLE },
  ]
  coord.loadWorkerRegistry('tab_cron_fire2').closed_tab_at = null
  closeCalls.length = 0
  const moved = await coord.close_my_tab({}, { tab_id: 'tab_cron_fire2' })
  ok('after a reorder the stable id still resolves to the right slot',
    moved.closed === true && closeCalls.length === 1 && closeCalls[0].tabIndex === 3,
    JSON.stringify({ moved: moved, calls: closeCalls }))

  console.log('\n== Part 4: safety. A stored id that is not live REFUSES, never falls through ==')
  // The fallthrough this guards: give the worker a UNIQUE live sentinel tab that
  // the legacy ladder WOULD resolve and close. With a stored-but-dead tabId the
  // resolver must refuse anyway. Without the control tab the refusal is vacuous.
  coord._registerWorkerInternal({ tab_id: 'tab_gone', task_id: 't-gone', tab_credential: 'c-gone' })
  coord.setWorkerTabHandle('tab_gone', {
    sentinel_prefix: '[9999 unique lane sentinel]',
    viewColumn: 1, viewType: CC, label_at_spawn: 'Claude Code', tabIndex: 0,
    autotitle_fingerprint: FINGERPRINT,
  })
  LIVE_TABS = [{ tabId: 'ttab_live_x', label: '[9999 unique lane sentinel]' }]

  closeCalls.length = 0
  const legacyOk = await coord.close_my_tab({}, { tab_id: 'tab_gone' })
  ok('CONTROL: with no tabId the legacy sentinel ladder DOES close this tab',
    legacyOk.closed === true && /sentinel/.test(String(legacyOk.strategy || '')), JSON.stringify(legacyOk))

  setTabId('tab_gone', 'ttab_that_no_longer_exists')
  closeCalls.length = 0
  const dead = await coord.close_my_tab({}, { tab_id: 'tab_gone' })
  ok('a stored id absent from the live listing REFUSES',
    dead.closed === false && /stable_id_not_live/.test(String(dead.refused || '')), JSON.stringify(dead))
  ok('and it closed NOTHING despite a resolvable legacy sentinel sitting right there',
    closeCalls.length === 0, JSON.stringify(closeCalls))

  console.log('\n== Part 5: safety. The conductor belt still applies to the stable id ==')
  coord._registerWorkerInternal({ tab_id: 'tab_conf', task_id: 't-conf', tab_credential: 'c-conf' })
  coord.setWorkerTabHandle('tab_conf', {
    sentinel_prefix: '[abcd conflict lane]', viewColumn: 1, viewType: CC,
    label_at_spawn: 'Claude Code', tabIndex: 0,
  })
  setTabId('tab_conf', 'ttab_conf_1_1')
  LIVE_TABS = [{ tabId: 'ttab_conf_1_1', label: 'CONDUCTOR OWN CHAT' }]
  closeCalls.length = 0
  const guarded = await coord.close_my_tab({}, { tab_id: 'tab_conf' })
  ok('a stable id resolving onto the registered conductor label is REFUSED',
    guarded.closed === false && /conductor_label_protected/.test(String(guarded.refused || '')), JSON.stringify(guarded))
  ok('and nothing was closed', closeCalls.length === 0)

  console.log('\n== Part 6: capture. signal_bound resolves this tab and persists its id ==')
  // Capture happens at bind, when the tab still carries its spawn sentinel and
  // Claude Code has not yet summarised it away.
  coord._registerWorkerInternal({ tab_id: 'tab_cap', task_id: 't-cap', tab_credential: 'c-cap' })
  coord.setWorkerTabHandle('tab_cap', {
    sentinel_prefix: '[cafe capture lane W9 persist]', viewColumn: 1, viewType: CC,
    label_at_spawn: 'Claude Code', tabIndex: 0,
  })
  LIVE_TABS = [
    { tabId: 'ttab_someone_else', label: 'Unrelated human chat' },
    { tabId: 'ttab_cap_1_1', label: '[cafe capture lane W9 …' },   // CC-truncated
  ]
  const cap = await coord._captureStableTabId('tab_cap')
  ok('capture resolves the truncated sentinel to the right live tab',
    cap.ok === true && cap.tabId === 'ttab_cap_1_1', JSON.stringify(cap))
  ok('capture persists the id onto the worker tab_handle',
    coord.loadWorkerRegistry('tab_cap').tab_handle.tabId === 'ttab_cap_1_1')
  ok('capture persists to disk, not only to the in-memory row',
    JSON.parse(fs.readFileSync(path.join(tmpRoot, 'workers', 'tab_cap.json'), 'utf8')).tab_handle.tabId === 'ttab_cap_1_1')

  console.log('\n== Part 7: capture on the cron collision. The corpse must not be claimed twice ==')
  // Fire N+1 binds while fire N corpse tab is still open, both carrying the same
  // sentinel. Capture must exclude the id another worker row already owns and
  // resolve the remaining one, not refuse and leave the cron permanently unfixed.
  coord._registerWorkerInternal({ tab_id: 'tab_fireA', task_id: 'cronrow', tab_credential: 'cA' })
  coord.setWorkerTabHandle('tab_fireA', {
    sentinel_prefix: '[dead beef nightly sweep]', viewColumn: 1, viewType: CC,
    label_at_spawn: 'Claude Code', tabIndex: 0,
  })
  LIVE_TABS = [{ tabId: 'ttab_A_1_1', label: '[dead beef nightly sw…' }]
  const capA = await coord._captureStableTabId('tab_fireA')
  ok('CONTROL: fire A captures cleanly when it is the only tab with that sentinel',
    capA.ok === true && capA.tabId === 'ttab_A_1_1', JSON.stringify(capA))

  coord._registerWorkerInternal({ tab_id: 'tab_fireB', task_id: 'cronrow', tab_credential: 'cB' })
  coord.setWorkerTabHandle('tab_fireB', {
    sentinel_prefix: '[dead beef nightly sweep]', viewColumn: 1, viewType: CC,
    label_at_spawn: 'Claude Code', tabIndex: 1,
  })
  LIVE_TABS = [
    { tabId: 'ttab_A_1_1', label: '[dead beef nightly sw…' },   // fire A corpse, id already claimed
    { tabId: 'ttab_B_1_1', label: '[dead beef nightly sw…' },   // fire B, the binding worker
  ]
  const capB = await coord._captureStableTabId('tab_fireB')
  ok('fire B captures the UNCLAIMED tab, not fire A corpse',
    capB.ok === true && capB.tabId === 'ttab_B_1_1', JSON.stringify(capB))

  // And the genuinely undecidable case still refuses rather than guessing.
  coord._registerWorkerInternal({ tab_id: 'tab_fireC', task_id: 'cronrow', tab_credential: 'cC' })
  coord.setWorkerTabHandle('tab_fireC', {
    sentinel_prefix: '[dead beef nightly sweep]', viewColumn: 1, viewType: CC,
    label_at_spawn: 'Claude Code', tabIndex: 2,
  })
  LIVE_TABS = [
    { tabId: 'ttab_A_1_1', label: '[dead beef nightly sw…' },   // claimed
    { tabId: 'ttab_B_1_1', label: '[dead beef nightly sw…' },   // claimed
    { tabId: 'ttab_C1', label: '[dead beef nightly sw…' },      // unclaimed
    { tabId: 'ttab_C2', label: '[dead beef nightly sw…' },      // unclaimed
  ]
  const capC = await coord._captureStableTabId('tab_fireC')
  ok('two unclaimed same-sentinel tabs REFUSE capture rather than guess',
    capC.ok === false && capC.reason === 'ambiguous_sentinel', JSON.stringify(capC))
  ok('and no id was written onto the refusing row',
    !coord.loadWorkerRegistry('tab_fireC').tab_handle.tabId)

  ide.tabs = realTabs
  ide.tabs_close = realClose
  console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'))
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => { console.error('THREW: ' + (e && e.stack || e)); process.exit(1) })
