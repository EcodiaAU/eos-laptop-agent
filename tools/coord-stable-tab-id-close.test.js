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

  console.log('\n== Part 4: a stored id that is not live RE-CAPTURES, and never steals ==')
  // 2026-08-29 lane W1-verify. CONTRACT CHANGED, deliberately. This part used to
  // assert that a stored-but-dead id refuses even with the worker's OWN tab
  // sitting right there under a UNIQUE sentinel. That refusal was not safety, it
  // was the leak: measured on the live agent, the sweep reported
  // stable_id_not_live on 26 rows every pass for hours, permanently, and
  // close_my_tab logged the same refusal per worker, because NOTHING re-runs
  // capture once a row has bound and the bridge re-mints an id whenever a tab
  // retitles and reorders.
  //
  // The no-fallthrough rule in the resolver is untouched. What changed is that a
  // PROVEN-DEAD id now gets one re-capture before it is treated as terminal. The
  // property that actually matters is kept and is asserted below in 4b: a
  // re-capture must never claim a tab another registry row owns.
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
  ok('a stored id absent from the live listing RE-CAPTURES instead of leaking',
    dead.closed === true && /stable_tab_id/.test(String(dead.strategy || '')), JSON.stringify(dead))
  ok('and it closed the tab bearing ITS OWN unique sentinel, not some other tab',
    closeCalls.length === 1 && closeCalls[0].exactLabel === '[9999 unique lane sentinel]',
    JSON.stringify(closeCalls))
  const goneRow = coord.loadWorkerRegistry('tab_gone')
  ok('and the row records the dead id it dropped, so the churn stays auditable',
    goneRow.tab_handle.tabId_stale_dropped === 'ttab_that_no_longer_exists',
    JSON.stringify(goneRow.tab_handle))

  // ── 4b. THE DANGER THE OLD REFUSAL WAS REALLY GUARDING, now tested directly.
  // A recurring cron re-fires a byte-identical brief, so fire A's corpse and
  // fire B's LIVE tab carry the same sentinel. If A's id dies and B is the only
  // match, a naive re-capture hands B's id to A and the next close shuts a
  // RUNNING worker down. _captureStableTabId used to consult the claimed-set
  // only when two or more tabs matched, so this single-hit case was unguarded.
  // It was unreachable while capture ran solely at signal_bound; re-capturing
  // from the close path is what makes it reachable.
  coord._registerWorkerInternal({ tab_id: 'tab_fireA', task_id: 't-fa', tab_credential: 'c-fa' })
  coord.setWorkerTabHandle('tab_fireA', {
    sentinel_prefix: '[7777 nightly cron lane]',
    viewColumn: 1, viewType: CC, label_at_spawn: 'Claude Code', tabIndex: 0,
  })
  coord._registerWorkerInternal({ tab_id: 'tab_fireB', task_id: 't-fb', tab_credential: 'c-fb' })
  coord.setWorkerTabHandle('tab_fireB', {
    sentinel_prefix: '[7777 nightly cron lane]',
    viewColumn: 1, viewType: CC, label_at_spawn: 'Claude Code', tabIndex: 1,
  })
  // B is alive and OWNS the one live tab showing that sentinel.
  setTabId('tab_fireB', 'ttab_fireB_live')
  setTabId('tab_fireA', 'ttab_fireA_dead')
  LIVE_TABS = [{ tabId: 'ttab_fireB_live', label: '[7777 nightly cron lane]' }]

  closeCalls.length = 0
  const w1capFireA = await coord._captureStableTabId('tab_fireA')
  ok('SAFETY: a lone sentinel match already claimed by a live sibling is REFUSED',
    w1capFireA.ok === false && w1capFireA.reason === 'sentinel_all_claimed', JSON.stringify(w1capFireA))
  const w1rowFireB = coord.loadWorkerRegistry('tab_fireB')
  ok("SAFETY: and the sibling keeps its own id, it was not reassigned",
    w1rowFireB.tab_handle.tabId === 'ttab_fireB_live', JSON.stringify(w1rowFireB.tab_handle))
  const w1closeFireA = await coord.close_my_tab({}, { tab_id: 'tab_fireA' })
  // The failed re-capture must NOT demote the row to "no id". If it did, Pass 0
  // would stand down and the legacy ladder would match this same sentinel onto
  // fire B's live tab. That is not hypothetical: an earlier cut of this fix did
  // exactly that and closed the sibling by 'tabIndex+sentinel:0'.
  ok('SAFETY: the dead fire REFUSES, it does not fall through to the ladder',
    w1closeFireA.closed === false && /stable_id_not_live|stable_id_dropped_not_recaptured/.test(String(w1closeFireA.refused || '')),
    JSON.stringify(w1closeFireA))
  ok('SAFETY: and no close was attempted against the live sibling tab',
    !closeCalls.some((c) => c.exactLabel === '[7777 nightly cron lane]'),
    JSON.stringify(closeCalls))

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


  console.log('\n== Part 8: the BOOTSTRAP state. Fire N binds while fires N-1 and N-2 are still open ==')
  //
  // WHY THIS CASE AND NOT THE ONE ABOVE. Part 3 proves capture survives ONE
  // corpse whose id is already claimed. That is the steady state AFTER the fix
  // has been running. It is not the state production is in.
  //
  // Production entered the fix with a backlog: 78 tabs at the 2026-08-29 count,
  // accreted by fires that predate the fix and therefore hold NO id. An
  // unclaimed corpse cannot be excluded by _claimedStableTabIds, so with two of
  // them the sentinel resolves 3 ways, capture refuses, fire N gets no id, and
  // fire N is now itself an unclaimed corpse poisoning fire N+1. The leak is
  // self-sustaining rather than decaying, which is why the one-shot reaper drained
  // 78 to 47 and the count was back to 62 by the next morning.
  //
  // The dispatcher-side spawn diff is what breaks that cycle, because it never
  // reads a label: it stands on both sides of the open and takes the id that
  // appeared, so no quantity of same-sentinel corpses is even a candidate.
  const dispatcher = require('./mac-dispatcher')
  const CRON = '[9f2a bootstrap cron lane B1 hourly]'
  const CRON_TRUNC = '[9f2a bootstrap cron l…'

  const mkFire = (tab_id) => {
    coord._registerWorkerInternal({ tab_id: tab_id, task_id: 'bootstrap-cron-row', tab_credential: 'c-' + tab_id })
    coord.setWorkerTabHandle(tab_id, {
      sentinel_prefix: CRON, viewColumn: 1, viewType: CC,
      label_at_spawn: 'Claude Code', tabIndex: 0,
    })
  }

  // Fires 1 and 2 leaked BEFORE the fix existed, so neither row carries an id.
  mkFire('tab_boot_f1')
  mkFire('tab_boot_f2')
  mkFire('tab_boot_f3')

  const bootBefore = [
    { tabId: 'ttab_boot1', label: CRON_TRUNC, viewColumn: 1, index: 0 },
    { tabId: 'ttab_boot2', label: CRON_TRUNC, viewColumn: 1, index: 1 },
  ]
  const bootAfter = bootBefore.concat([
    { tabId: 'ttab_boot3', label: CRON_TRUNC, viewColumn: 1, index: 2 },
  ])

  // 4a. THE HOLE, stated as an assertion rather than a comment. This is the
  //     production state and bind-time capture cannot resolve it.
  LIVE_TABS = bootAfter.map((t) => ({ tabId: t.tabId, label: t.label }))
  const bootCap = await coord._captureStableTabId('tab_boot_f3')
  ok('BOOTSTRAP HOLE: with two UNCLAIMED corpses, bind-time capture refuses',
    bootCap.ok === false && bootCap.reason === 'ambiguous_sentinel', JSON.stringify(bootCap))
  ok('and fire N is left with no id, so it becomes the next fire poison',
    !coord.loadWorkerRegistry('tab_boot_f3').tab_handle.tabId)

  // 4b. THE FIX. Same fixture, dispatcher side. One new id appeared.
  const spawned = dispatcher._diffSpawnedCcTab(bootBefore, bootAfter, CRON)
  ok('SPAWN DIFF resolves fire N in the exact state that defeats capture',
    spawned.ok === true && spawned.tab.tabId === 'ttab_boot3' && spawned.via === 'dispatch_spawn_diff',
    JSON.stringify(spawned))

  // 4c. The diff is LABEL-INDEPENDENT, which is the whole point. Claude Code has
  //     already retitled the new tab to the same summary as both corpses, so
  //     there is no label in this fixture that could pick it out.
  const retitled = [
    { tabId: 'ttab_boot1', label: 'Bootstrap cron hourly…' },
    { tabId: 'ttab_boot2', label: 'Bootstrap cron hourly…' },
    { tabId: 'ttab_boot3', label: 'Bootstrap cron hourly…' },
  ]
  const spawnedRetitled = dispatcher._diffSpawnedCcTab(
    retitled.slice(0, 2), retitled, CRON)
  ok('SPAWN DIFF still resolves when all three tabs share one autotitle',
    spawnedRetitled.ok === true && spawnedRetitled.tab.tabId === 'ttab_boot3',
    JSON.stringify(spawnedRetitled))

  // 4d. Once the dispatcher has stamped, bind-time capture stops guessing and
  //     short-circuits on the stored id. This is the handoff between the two
  //     halves and it is what makes the sentinel ladder dead code for crons.
  const w3 = coord.loadWorkerRegistry('tab_boot_f3')
  w3.tab_handle.tabId = spawned.tab.tabId
  coord.setWorkerTabHandle('tab_boot_f3', w3.tab_handle)
  const bootCap2 = await coord._captureStableTabId('tab_boot_f3')
  ok('after the spawn stamp, capture short-circuits instead of refusing',
    bootCap2.ok === true && bootCap2.tabId === 'ttab_boot3' && bootCap2.reason === 'already_set',
    JSON.stringify(bootCap2))

  // 4e. And the close now resolves, which is the outcome the whole chain exists
  //     for. Without the stamp this row had no id at all and fell to the
  //     colliding legacy ladder.
  const bootResolved = await coord._resolveStableIdCloseTarget('tab_boot_f3', 65535)
  ok('close resolves fire N to its own tab, not a corpse',
    !!bootResolved.tab && bootResolved.tabId === 'ttab_boot3', JSON.stringify(bootResolved))

  // 4f. CONTROL, and it has to be here or 4b proves only that a set difference
  //     works. Two tabs appear inside the dispatch window (a human opened a chat
  //     while the cron was spawning) and neither carries our sentinel, so the
  //     tiebreak cannot pick and the diff REFUSES rather than taking the first.
  const twoNew = bootBefore.concat([
    { tabId: 'ttab_boot3', label: 'Some human chat' },
    { tabId: 'ttab_human', label: 'Another human chat' },
  ])
  const amb = dispatcher._diffSpawnedCcTab(bootBefore, twoNew, CRON)
  ok('CONTROL: two unattributable new tabs REFUSE rather than guess',
    amb.ok === false && amb.reason === 'ambiguous_new_tabs' && amb.fresh === 2,
    JSON.stringify(amb))

  // 4g. The tiebreak, and note it can only ever narrow tabs that are ALREADY new.
  //     A same-sentinel corpse is not new, so it was excluded before any label
  //     was read; that ordering is what stops the tiebreak reintroducing the very
  //     collision the diff exists to avoid.
  const twoNewOneOurs = bootBefore.concat([
    { tabId: 'ttab_human', label: 'Another human chat' },
    { tabId: 'ttab_boot3', label: CRON_TRUNC },
  ])
  const tie = dispatcher._diffSpawnedCcTab(bootBefore, twoNewOneOurs, CRON)
  ok('tiebreak picks OUR new tab when a human tab opened in the same window',
    tie.ok === true && tie.tab.tabId === 'ttab_boot3' && tie.via === 'dispatch_spawn_diff_sentinel',
    JSON.stringify(tie))

  // 4h. FAIL-SAFE. A bridge outage gives no snapshot. "No snapshot" must not
  //     collapse into "no tabs", because differencing against an empty set calls
  //     every live tab new and would stamp a stranger's id onto this worker.
  const noSnap = dispatcher._diffSpawnedCcTab(null, bootAfter, CRON)
  ok('FAIL-SAFE: a missing before-snapshot refuses, never treats all tabs as new',
    noSnap.ok === false && noSnap.reason === 'no_snapshot', JSON.stringify(noSnap))

  // 4i. And the reconcile edge: assignStableTabIds matches a tab to a prior id by
  //     (viewColumn, index), so a tab closing as ours opens at the same slot can
  //     hand ours the departed id and the diff sees nothing new. It declines and
  //     names the reason; it must NOT fail the dispatch, which did succeed.
  const noNew = dispatcher._diffSpawnedCcTab(bootAfter, bootAfter, CRON)
  ok('a reconciled id yields no new tab, declines cleanly rather than throwing',
    noNew.ok === false && noNew.reason === 'no_new_tab_id', JSON.stringify(noNew))

  console.log('\n== Part 9: the stored id is not self-evidently good. Stale-at-bind repair ==')

  // Measured on the live fleet 2026-08-29, after the dispatcher stamp shipped:
  // 0 of 10 dispatch_spawn_diff ids still resolved to a live tab, against 8 of
  // 10 for the slower bind-time sentinel capture. The bridge re-mints an id when
  // a tab RETITLES and REORDERS between two listings (assignStableTabIds keys on
  // viewColumn+label, then viewColumn+index, and nothing else). The dispatcher
  // captures at ~3s while the tab still reads "Claude Code"; Claude Code
  // autotitles it ~11s later, and the id the dispatcher stored is orphaned.
  //
  // That is worse than storing nothing, because close_my_tab treats a stored id
  // as TERMINAL: it refuses and never runs the tiers below. So a stale id does
  // not degrade the close, it guarantees the leak. The terminal rule is correct
  // and stays; the repair is here at capture.
  //
  // CC keeps the sentinel at the head of its summary (the brief opens with it),
  // truncated to 24 chars plus an ellipsis, which is why the bind-time sentinel
  // tier still resolves after the retitle.
  const RETITLED = SENTINEL.slice(0, 24) + '…'

  // 9a. CONTROL: a stored id that IS live must still short-circuit untouched.
  //     Without this, an assertion that a stale id gets replaced proves nothing.
  mkCronWorker('w-live-id', 4)
  setTabId('w-live-id', 'ttab_live_1_1')
  LIVE_TABS = [{ tabId: 'ttab_live_1_1', label: RETITLED, viewColumn: 1, viewType: CC, index: 4 }]
  const keptRes = await coord._captureStableTabId('w-live-id')
  ok('CONTROL: a LIVE stored id short-circuits and is not re-captured',
    keptRes.ok === true && keptRes.reason === 'already_set' && keptRes.tabId === 'ttab_live_1_1',
    JSON.stringify(keptRes))

  // 9b. The real shape. The dispatcher stamped the pre-autotitle id; the bridge
  //     has since re-minted the tab. Re-capture must replace it with the live id.
  mkCronWorker('w-stale-id', 5)
  setTabId('w-stale-id', 'ttab_preautotitle_1_1')
  LIVE_TABS = [{ tabId: 'ttab_reminted_1_1', label: RETITLED, viewColumn: 1, viewType: CC, index: 5 }]
  const repaired = await coord._captureStableTabId('w-stale-id')
  ok('a STALE stored id is dropped and re-captured against the current labels',
    repaired.ok === true && repaired.tabId === 'ttab_reminted_1_1',
    JSON.stringify(repaired))
  const wRep = coord.loadWorkerRegistry('w-stale-id')
  ok('and the row records which id was dropped, so the churn stays visible',
    wRep.tab_handle.tabId === 'ttab_reminted_1_1'
      && wRep.tab_handle.tabId_stale_dropped === 'ttab_preautotitle_1_1',
    JSON.stringify(wRep.tab_handle))

  // 9c. Re-capture cannot always win: two unclaimed same-sentinel corpses are
  //     genuinely undecidable. The id must still be GONE, so the close resolves
  //     {none} and the legacy ladder runs, rather than {refused} which would
  //     hard-stop the close on a value already proven wrong.
  mkCronWorker('w-stale-ambig', 6)
  setTabId('w-stale-ambig', 'ttab_preautotitle_2_1')
  LIVE_TABS = [
    { tabId: 'ttab_corpseA_1_1', label: RETITLED, viewColumn: 1, viewType: CC, index: 6 },
    { tabId: 'ttab_corpseB_1_1', label: RETITLED, viewColumn: 1, viewType: CC, index: 7 },
  ]
  const ambig = await coord._captureStableTabId('w-stale-ambig')
  ok('an undecidable re-capture still refuses rather than guessing',
    ambig.ok === false && ambig.reason === 'ambiguous_sentinel', JSON.stringify(ambig))
  const wAmb = coord.loadWorkerRegistry('w-stale-ambig')
  ok('the proven-dead id is GONE from the row, and the drop is recorded',
    !wAmb.tab_handle.tabId && wAmb.tab_handle.tabId_stale_dropped === 'ttab_preautotitle_2_1',
    JSON.stringify(wAmb.tab_handle))
  const settles = await coord._resolveStableIdCloseTarget('w-stale-ambig', 65535)
  // 2026-08-29 lane W1-verify. CONTRACT CORRECTED. This used to assert that a
  // dropped id resolves {none} so "the legacy tiers run". That is the hazard, not
  // the feature, and THIS FIXTURE IS THE PROOF: the two corpses here share a
  // retitled label, the exact input the ladder cannot tell apart. Handing this row
  // to the ladder is how a cleanup closes a live sibling fire. A row that HAD an id
  // and lost it stays terminal; only a row that never had one earns the ladder.
  ok('and that row stays TERMINAL, it is not promoted to the legacy tiers',
    !!settles && !settles.none
      && /stable_id_dropped_not_recaptured/.test(String(settles.refused || '')),
    JSON.stringify(settles))

  // 9d. FAIL-SAFE, the direction that matters. An empty or failed listing proves
  //     NOTHING about the stored id. Dropping it there would discard a good id
  //     every time the bridge hiccups, which is the mirror-image bug.
  mkCronWorker('w-bridge-dark', 8)
  setTabId('w-bridge-dark', 'ttab_unverifiable_1_1')
  LIVE_TABS = []
  const dark = await coord._captureStableTabId('w-bridge-dark')
  ok('FAIL-SAFE: an empty listing keeps the stored id, it does not prove it dead',
    dark.ok === true && dark.tabId === 'ttab_unverifiable_1_1'
      && dark.reason === 'already_set_liveness_unknown', JSON.stringify(dark))
  const wDark = coord.loadWorkerRegistry('w-bridge-dark')
  ok('and nothing was dropped on that path',
    wDark.tab_handle.tabId === 'ttab_unverifiable_1_1' && !wDark.tab_handle.tabId_stale_dropped,
    JSON.stringify(wDark.tab_handle))

  // 10. THE WRONG-CLOSE THAT ACTUALLY HAPPENED, 2026-08-29 lane W1-verify3.
  //     A worker bound carrying an id it had never earned (the dispatcher's
  //     spawn-diff stamp, measured 0 of 10 still resolving), that id named the
  //     LIVE HUMAN CHAT "Crons", and every check on the way to the close asked
  //     only whether the id was alive. It was alive. It was not this worker's.
  //     close_my_tab closed Tate's chat and left the worker's own tab open.
  //
  //     LIVENESS IS NOT IDENTITY. A dead id expires by itself; a wrong-but-alive
  //     id is held alive by its real owner and never expires.
  mkCronWorker('w-wrongid', 0)
  setTabId('w-wrongid', 'ttab_someone_elses_chat')
  LIVE_TABS = [
    { tabId: 'ttab_someone_elses_chat', label: 'Crons', viewColumn: 1, index: 0 },
    { tabId: 'ttab_my_real_tab', label: SENTINEL, viewColumn: 1, index: 1 },
  ]
  const wrong = await coord._resolveStableIdCloseTargetRecapturing('w-wrongid', 7457)
  ok('a stored id naming a DIFFERENT live chat does not become a close target',
    wrong.tabId !== 'ttab_someone_elses_chat', JSON.stringify(wrong))
  ok('and it re-captures onto the tab actually wearing this worker sentinel',
    wrong.tabId === 'ttab_my_real_tab', JSON.stringify(wrong))

  //     THE CONTROL that makes the rule narrow, and the one an over-strict fix
  //     breaks: an AUTOTITLED tab no longer wears its sentinel, and nothing else
  //     does either. Nothing contradicts the stored id, so it is TRUSTED. This
  //     is the entire reason the stable id exists, so demanding a positive label
  //     match here would reduce it to the label ladder it replaced.
  mkCronWorker('w-autotitled', 1)
  setTabId('w-autotitled', 'ttab_autotitled_mine')
  LIVE_TABS = [
    { tabId: 'ttab_autotitled_mine', label: 'Pattern binding TTL sweep', viewColumn: 1, index: 0 },
    { tabId: 'ttab_unrelated', label: 'Some human chat', viewColumn: 1, index: 1 },
  ]
  const auto = await coord._resolveStableIdCloseTargetRecapturing('w-autotitled', 7457)
  ok('CONTROL: an autotitled tab that nothing contradicts KEEPS its stored id',
    auto.tabId === 'ttab_autotitled_mine', JSON.stringify(auto))

  //     And the claimed-set stays decisive whatever the labels read.
  mkCronWorker('w-claimant', 2)
  setTabId('w-claimant', 'ttab_owned_by_claimant')
  mkCronWorker('w-thief', 3)
  setTabId('w-thief', 'ttab_owned_by_claimant')
  LIVE_TABS = [{ tabId: 'ttab_owned_by_claimant', label: 'Pattern binding TTL sweep', viewColumn: 1, index: 0 }]
  const thief = await coord._resolveStableIdCloseTargetRecapturing('w-thief', 7457)
  ok('a tab another registry row already claims is never closed as mine',
    thief.tabId !== 'ttab_owned_by_claimant', JSON.stringify(thief))

  // ── A FOSSIL CLAIM IS NOT A CLAIM (2026-08-29 lane C5). ───────────────────
  //
  // The claimed-set was built over EVERY row on disk, terminated ones included,
  // and the bridge recycles ids: assignStableTabIds pass 2 matches on
  // (viewColumn, index), so a tab that shifts into a closed tab's slot INHERITS
  // its id. Every worker tab lives at the end of viewColumn 1, so this is the
  // normal case for a cron. Fire N terminates holding id X, fire N+1's live tab
  // inherits X, and at N+1's close the recapture found its own tab, saw X
  // "claimed" by N's corpse row, filtered every hit and returned
  // sentinel_all_claimed. The row was then left with no id AND marked as having
  // had one, which resolves as the TERMINAL stable_id_dropped_not_recaptured, so
  // the anchor and label tiers below it never ran. Guaranteed leak, every fire.
  // Field evidence: three consecutive orphan sweeps reporting
  // stable_id_dropped_not_recaptured 26, then 34, then 41, closing 0 or 1 of
  // 76 to 93 candidates.
  const terminate = (tab_id) => {
    const w = coord.loadWorkerRegistry(tab_id)
    w.terminated_at = new Date().toISOString()
  }

  mkCronWorker('w-fossil-corpse', 0)
  setTabId('w-fossil-corpse', 'ttab_recycled_id')
  terminate('w-fossil-corpse')
  mkCronWorker('w-fossil-live', 1)
  setTabId('w-fossil-live', 'ttab_now_dead')     // its bind-time id, since re-minted
  LIVE_TABS = [{ tabId: 'ttab_recycled_id', label: SENTINEL, viewColumn: 1, index: 0 }]
  const fossil = await coord._resolveStableIdCloseTargetRecapturing('w-fossil-live', 7457)
  ok('a recycled id claimed only by a TERMINATED row is recaptured, not refused',
    fossil.tabId === 'ttab_recycled_id', JSON.stringify(fossil))

  // THE CONTROL, and it is the whole safety argument. Identical fixture, one
  // variable changed: the claiming row is still RUNNING. A live worker's claim
  // must still block unconditionally, because taking it would close a running
  // worker, which is the worst thing this subsystem can do.
  mkCronWorker('w-livecorpse-claimant', 0)
  setTabId('w-livecorpse-claimant', 'ttab_recycled_id2')
  mkCronWorker('w-livecorpse-taker', 1)
  setTabId('w-livecorpse-taker', 'ttab_now_dead2')
  LIVE_TABS = [{ tabId: 'ttab_recycled_id2', label: SENTINEL, viewColumn: 1, index: 0 }]
  const livecl = await coord._resolveStableIdCloseTargetRecapturing('w-livecorpse-taker', 7457)
  ok('CONTROL: the same id claimed by a RUNNING row is still refused',
    livecl.tabId !== 'ttab_recycled_id2', JSON.stringify(livecl))

  // And the relaxation is single-hit only. Two live tabs wearing the sentinel
  // means the sibling fire's corpse is still open and there is a real choice to
  // get wrong, so the full claimed set still applies and ambiguity still refuses.
  mkCronWorker('w-twohit-corpse', 0)
  setTabId('w-twohit-corpse', 'ttab_twohit_a')
  terminate('w-twohit-corpse')
  mkCronWorker('w-twohit-live', 1)
  setTabId('w-twohit-live', 'ttab_twohit_gone')
  LIVE_TABS = [
    { tabId: 'ttab_twohit_a', label: SENTINEL, viewColumn: 1, index: 0 },
    { tabId: 'ttab_twohit_b', label: SENTINEL, viewColumn: 1, index: 1 },
  ]
  const twohit = await coord._resolveStableIdCloseTargetRecapturing('w-twohit-live', 7457)
  ok('CONTROL: two live tabs wear the sentinel, so the corpse claim still filters and one survives',
    twohit.tabId === 'ttab_twohit_b', JSON.stringify(twohit))


  console.log('\n== Part 10: the fossil claim must still CONTRADICT unless the held tab is mine ==')
  // dbf8723 relaxed BOTH claim checks to liveOnly:true on the premise "a
  // TERMINATED row is not another live worker". The premise is about the
  // CLAIMANT and says nothing about the HELD TAB, and _storedIdContradicted is
  // the one place that difference matters. Its job is to answer "is this id
  // still MINE", and a corpse row naming the id is evidence that it is not,
  // whoever is wearing it now. Dropping fossil claims here means: caller W's
  // stored id was recycled onto a live tab, W's own tab is gone so nothing wears
  // W's sentinel and arm (b) cannot fire, no live row claims the tab, and the
  // close proceeds against a stranger who is working. The pre-dbf8723 all-rows
  // check refused exactly that. Reachable from kill_worker and the orphan
  // sweeps, which run this resolver against dead workers' rows continuously.
  //
  // The gate is IDENTITY, and it has to be measured rather than assumed, because
  // the same identity-gating idea is recorded in this file's own history as the
  // repair that broke every legitimate cron close. Measured on the live corpus
  // 2026-08-29 (1587 worker-role anchors): every live worker tab still wears its
  // sentinel, because the dispatcher writes the sentinel as the brief's first
  // line and Claude Code titles the tab from it. The real hazard is the OTHER
  // truncation direction: 309 of 1587 labels show the WHOLE sentinel plus
  // spillover ("[600f morning pass]\n<dis…"), and _labelMatchesStored answers
  // false on 278 of those 309 because it only tests full.startsWith(visible).
  // Those 309 are the short-named recurring crons, i.e. exactly the population
  // this whole lane exists to stop leaking. So the gate uses a bidirectional
  // test that also accepts visible.startsWith(full): 309 of 309 recognised.

  const SHORT = '[600f morning pass]'
  const SPILL = '[600f morning pass]\n<dis…'   // whole sentinel visible + spillover
  const STRANGER = 'Client onboarding notes…'

  function mkNamed(tab_id, sentinel, spawnIndex) {
    coord._registerWorkerInternal({ tab_id: tab_id, task_id: 'row-' + tab_id, tab_credential: 'cred-' + tab_id })
    coord.setWorkerTabHandle(tab_id, {
      sentinel_prefix: sentinel,
      viewColumn: 1,
      viewType: CC,
      label_at_spawn: 'Claude Code',
      tabIndex: spawnIndex,
      autotitle_fingerprint: FINGERPRINT,
    })
  }
  const kill = (tab_id) => { coord.loadWorkerRegistry(tab_id).terminated_at = new Date().toISOString() }
  const th = (tab_id) => coord.loadWorkerRegistry(tab_id).tab_handle

  // (c) THE WRONG-CLOSE. Fails first on the deployed code.
  mkNamed('f-c-corpse', SENTINEL, 0); setTabId('f-c-corpse', 'ttab_fc'); kill('f-c-corpse')
  mkNamed('f-c-caller', SENTINEL, 1)
  th('f-c-caller').tabId = 'ttab_fc'                      // recycled onto a stranger's tab
  LIVE_TABS = [{ tabId: 'ttab_fc', label: STRANGER, viewColumn: 1, index: 0 }]
  const tabsC = LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t))
  ok('(c) a fossil claim on a tab wearing a STRANGER title CONTRADICTS',
    coord._storedIdContradicted(th('f-c-caller'), tabsC, 'f-c-caller', 'ttab_fc') === true)
  const resC = await coord._resolveStableIdCloseTarget('f-c-caller', 7457)
  ok('(c) end to end: the resolver REFUSES stable_id_not_mine instead of handing over the stranger',
    /^stable_id_not_mine:/.test(String(resC.refused || '')), JSON.stringify(resC))

  // (a) POSITIVE CONTROL. Same fixture, one variable changed: the held tab wears
  // the caller's sentinel, truncated mid-sentinel. Must NOT contradict.
  mkNamed('f-a-corpse', SENTINEL, 0); setTabId('f-a-corpse', 'ttab_fa'); kill('f-a-corpse')
  mkNamed('f-a-caller', SENTINEL, 1)
  th('f-a-caller').tabId = 'ttab_fa'
  LIVE_TABS = [{ tabId: 'ttab_fa', label: SENTINEL.slice(0, 24) + '…', viewColumn: 1, index: 0 }]
  const tabsA = LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t))
  ok('(a) CONTROL: a fossil claim on a tab wearing my truncated sentinel does NOT contradict',
    coord._storedIdContradicted(th('f-a-caller'), tabsA, 'f-a-caller', 'ttab_fa') === false)
  const resA = await coord._resolveStableIdCloseTarget('f-a-caller', 7457)
  ok('(a) CONTROL end to end: the resolver still hands over the tab', resA.tabId === 'ttab_fa', JSON.stringify(resA))

  // (b) THE LEAK-REINTRODUCTION CONTROL, and the reason the gate is
  // bidirectional. A short-named cron whose whole sentinel fits inside the
  // 24-char window shows sentinel + spillover. One-directional matching answers
  // false here and would refuse this close, which is the exact leak dbf8723 was
  // removing. 309 of 1587 live-corpus labels are this shape.
  mkNamed('f-b-corpse', SHORT, 0); setTabId('f-b-corpse', 'ttab_fb')
  th('f-b-corpse').tabId_captured_label = SHORT; kill('f-b-corpse')
  mkNamed('f-b-caller', SHORT, 1)
  th('f-b-caller').tabId = 'ttab_fb'
  LIVE_TABS = [{ tabId: 'ttab_fb', label: SPILL, viewColumn: 1, index: 0 }]
  const tabsB = LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t))
  ok('(b) CONTROL: sentinel-plus-spillover is still MY identity, so no contradiction and no new leak',
    coord._storedIdContradicted(th('f-b-caller'), tabsB, 'f-b-caller', 'ttab_fb') === false)
  ok('(b) and the one-directional test is what would have got this wrong',
    coord._labelMatchesStored(SPILL, SHORT) === false)
  const resB = await coord._resolveStableIdCloseTarget('f-b-caller', 7457)
  ok('(b) CONTROL end to end: the short-named cron still closes its own tab', resB.tabId === 'ttab_fb', JSON.stringify(resB))

  // (d) NEGATIVE CONTROL. No claimant at all, stranger label. Nothing to
  // contradict with, so behaviour is unchanged by this commit.
  mkNamed('f-d-caller', SENTINEL, 0)
  th('f-d-caller').tabId = 'ttab_fd'
  LIVE_TABS = [{ tabId: 'ttab_fd', label: STRANGER, viewColumn: 1, index: 0 }]
  const tabsD = LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t))
  ok('(d) CONTROL: an UNCLAIMED id on an autotitled tab still does not contradict',
    coord._storedIdContradicted(th('f-d-caller'), tabsD, 'f-d-caller', 'ttab_fd') === false)

  // (e) The live-claimant arm is untouched by this commit and must stay decisive.
  mkNamed('f-e-live', SENTINEL, 0); setTabId('f-e-live', 'ttab_fe')
  mkNamed('f-e-caller', SENTINEL, 1)
  th('f-e-caller').tabId = 'ttab_fe'
  LIVE_TABS = [{ tabId: 'ttab_fe', label: SENTINEL.slice(0, 24) + '…', viewColumn: 1, index: 0 }]
  const tabsE = LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t))
  ok('(e) CONTROL: a LIVE row claiming the held tab still contradicts even when the label reads as mine',
    coord._storedIdContradicted(th('f-e-caller'), tabsE, 'f-e-caller', 'ttab_fe') === true)

  ide.tabs = realTabs
  ide.tabs_close = realClose
  console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'))
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => { console.error('THREW: ' + (e && e.stack || e)); process.exit(1) })
