'use strict'

// Regression test for F7, the marker a contradiction drop wrote and then erased
// one line later (2026-08-29, lane W1).
//
// THE DEFECT. _captureStableTabId has two ways to lose a stored id, and they sit
// in the same block. The CONTRADICTION arm (the id is alive but another live tab
// wears my identity) drops it, sets tabId_stale_dropped = wrongId to earn the
// ladder ban a lost id is owed, writes the row, and falls through on purpose so
// the re-capture below it can find the right tab. Directly below sat the
// PROVEN-DEAD arm, unguarded, and the fall-through walked straight into it:
//
//     const staleId = th.tabId          // just deleted -> undefined
//     th.tabId_stale_dropped = staleId  // clobbers the marker with undefined
//
// JSON.stringify OMITS an undefined value, so the durable row came back from
// disk with tabId_stale_dropped ABSENT while its two timestamp siblings
// (tabId_stale_dropped_at, tabId_stale_dropped_from_via) survived and made the
// row LOOK correctly marked. Measured on a daemon-written file, not theorised.
//
// WHY IT BITES, on THREE consumers that all gate on that one marker:
//   1. _resolveStableIdCloseTarget returns {none} instead of
//      {refused: stable_id_dropped_not_recaptured}. {none} carries neither
//      .refused nor .tab, so close_my_tab never sets stableSettled and falls to
//      the session-anchor tier and then the legacy label/tabIndex ladder.
//   2. kill_worker makes the identical call and reaches the identical ladder,
//      with a weaker belt: it passes {} rather than GUARD_SELF_CLOSE, so only a
//      FOCUSED tab is spared. An unfocused live sibling has nothing.
//   3. cowork.js runOrphanSweep gates its resolver call on
//      `if (th.tabId || th.tabId_stale_dropped)`. Both false, so the row falls
//      PAST the resolver into Pass 1, tabIndex+sentinel. That gate's own comment
//      says it admits the marker precisely to stop this promotion.
// On a recurring cron every handle is derived from a byte-identical brief, so
// the ladder resolves a dead fire's sentinel onto a SIBLING FIRE'S LIVE TAB.
// That is a cleanup killing a running worker.
//
// _resolveStableIdCloseTargetRecapturing does NOT save it. Its
// `if (after && after.none) return st` guard restores a PRIOR refusal, so it
// protects only the call that did the dropping. On the SECOND call the first
// resolve is already {none}, `repairable` is false, and the wrapper hands {none}
// straight back untouched. The second call is the one that runs in the field:
// eos-laptop-agent.err.log carries "close_my_tab refused twice ... Attempting
// the registry-resolved kill path" as a standing pattern.
//
// THE FIX. The proven-dead block becomes an `else` of `if (liveIds.has(...))`.
// Both arms still fall through to the shared re-capture below, which is the part
// that was always intended.
//
// Every assertion here is PAIRED with a control that differs only in the
// variable under test. Doctrine:
// a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-contradiction-drop-marker.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-contradiction-'))
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
const SENTINEL = '[9f31 contradiction drop marker]'

let LIVE_TABS = []
const realTabs = ide.tabs
const realClose = ide.tabs_close
const closeCalls = []

ide.tabs = async () => ({
  groups: [{
    viewColumn: 1,
    isActive: true,
    tabs: LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t)),
  }],
})
ide.tabs_close = async (req) => { closeCalls.push(req); return { closed: 1, matched: 1 } }

let fails = 0
function ok(name, cond, extra) {
  if (cond) { console.log('  PASS: ' + name) }
  else { console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); fails++ }
}

function mkWorker(tab_id, sentinel) {
  coord._registerWorkerInternal({ tab_id: tab_id, task_id: 'contradiction-row', tab_credential: 'cred-' + tab_id })
  coord.setWorkerTabHandle(tab_id, {
    sentinel_prefix: sentinel,
    viewColumn: 1,
    viewType: CC,
    label_at_spawn: 'Claude Code',
    tabIndex: 0,
    captured_via: 'bridge_chat_send_message',
    captured_label_is_provisional: true,
  })
}
function setTabId(tab_id, ttab) {
  const w = coord.loadWorkerRegistry(tab_id)
  w.tab_handle.tabId = ttab
  w.tab_handle.tabId_captured_at = new Date().toISOString()
  w.tab_handle.tabId_captured_via = 'dispatch_spawn_diff'
  // Persist. The in-memory map is what capture reads, but every assertion below
  // reads the DURABLE row, and a fixture that only sets memory would make the
  // "id is gone from disk" checks pass vacuously against an id never written.
  fs.writeFileSync(path.join(tmpRoot, 'workers', tab_id + '.json'), JSON.stringify(w, null, 2))
}
// THE POINT OF THE WHOLE FILE. The failure is JSON.stringify omitting an
// undefined value, which the in-memory object cannot show you: in memory the key
// is present-and-undefined, on disk it is gone. Read the durable row.
function diskRow(tab_id) {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'workers', tab_id + '.json'), 'utf8'))
}

;(async () => {
  console.log('\n== Part 1: the contradiction drop must persist its marker to DISK ==')

  // The field shape. The row carries an id the dispatcher stamped at ~3s
  // (measured 0 of 10 still resolving); that id is ALIVE and belongs to a
  // stranger, while a different live tab wears this row's sentinel.
  mkWorker('w-contradicted', SENTINEL)
  setTabId('w-contradicted', 'ttab_stranger_1_1')
  LIVE_TABS = [
    { tabId: 'ttab_stranger_1_1', label: 'Some human chat about invoices', viewColumn: 1, index: 0 },
    // The label must be the sentinel EXACTLY or a truncation of it:
    // _labelMatchesStored accepts live === full, or a truncated live whose
    // visible prefix the stored value starts with. Nothing else matches.
    { tabId: 'ttab_wears_my_sentinel_1_1', label: SENTINEL, viewColumn: 1, index: 1 },
  ]
  // Claim the sentinel-wearing tab from a SECOND registry row, so the re-capture
  // inside this same call cannot succeed. That is what leaves the row id-less,
  // which is the only state in which the marker matters at all.
  mkWorker('w-owns-the-sentinel-tab', SENTINEL)
  setTabId('w-owns-the-sentinel-tab', 'ttab_wears_my_sentinel_1_1')

  const cap = await coord._captureStableTabId('w-contradicted')
  ok('the contradicted id is dropped and the re-capture cannot replace it',
    cap.ok === false && cap.reason === 'sentinel_all_claimed', JSON.stringify(cap))

  const row = diskRow('w-contradicted')
  const th = row.tab_handle
  ok('CONTROL: the wrong-drop audit fields DID reach disk (so the row was written)',
    th.tabId_wrong_dropped === 'ttab_stranger_1_1'
      && th.tabId_wrong_dropped_why === 'another_live_tab_wears_my_identity',
    JSON.stringify(th))
  ok('CONTROL: the id itself is gone from the durable row',
    !th.tabId, JSON.stringify(th))
  // THE DEFECT ASSERTION. Absent, not merely falsy: JSON.stringify deletes an
  // undefined value outright, which is exactly how this hid.
  ok('THE FIX: tabId_stale_dropped survives to disk carrying the WRONG id',
    Object.prototype.hasOwnProperty.call(th, 'tabId_stale_dropped')
      && th.tabId_stale_dropped === 'ttab_stranger_1_1',
    'keys=' + JSON.stringify(Object.keys(th).filter((k) => /stale_dropped/.test(k))))

  console.log('\n== Part 2: the RETRY, which is the whole point ==')
  // Call 1 dropped. Call 2 is the one the field actually makes, and the
  // recapturing wrapper's {none} guard cannot help it: there is no prior
  // refusal left to restore.
  const second = await coord._resolveStableIdCloseTargetRecapturing('w-contradicted', 65535)
  ok('a SECOND close resolves TERMINAL, naming the dropped id',
    !!second && !second.none && !second.tab
      && second.refused === 'stable_id_dropped_not_recaptured:ttab_stranger_1_1',
    JSON.stringify(second))
  ok('and it is NOT {none}, which is what promotes a row to the legacy ladder',
    !(second && second.none), JSON.stringify(second))

  // The consequence, end to end: close_my_tab must refuse rather than reach the
  // ladder and close the live sibling that wears the same sentinel.
  closeCalls.length = 0
  const closed = await coord.close_my_tab({}, { tab_id: 'w-contradicted' })
  ok('close_my_tab REFUSES instead of running the ladder',
    closed.closed === false && /stable_id_dropped_not_recaptured/.test(String(closed.refused || '')),
    JSON.stringify(closed))
  ok('and the live tab wearing our sentinel was never touched',
    closeCalls.length === 0, JSON.stringify(closeCalls))

  console.log('\n== Part 3: controls. The proven-dead arm and the fail-safe are unchanged ==')

  // CONTROL A: the proven-dead arm still writes the marker with the DEAD id. If
  // the `else` were placed wrong this is what would break.
  mkWorker('w-proven-dead', '[9f31 proven dead]')
  setTabId('w-proven-dead', 'ttab_long_gone_1_1')
  LIVE_TABS = [{ tabId: 'ttab_unrelated_1_1', label: 'Nothing to do with us', viewColumn: 1, index: 0 }]
  const deadCap = await coord._captureStableTabId('w-proven-dead')
  ok('CONTROL: a proven-dead id still fails to re-capture', deadCap.ok === false, JSON.stringify(deadCap))
  const deadRow = diskRow('w-proven-dead').tab_handle
  ok('CONTROL: the proven-dead arm still marks the row with the DEAD id',
    deadRow.tabId_stale_dropped === 'ttab_long_gone_1_1' && !deadRow.tabId,
    JSON.stringify(deadRow))
  ok('CONTROL: and it did NOT take the contradiction arm (no wrong_dropped audit)',
    !deadRow.tabId_wrong_dropped, JSON.stringify(deadRow))
  const deadResolve = await coord._resolveStableIdCloseTarget('w-proven-dead', 65535)
  ok('CONTROL: the proven-dead row is terminal too',
    /stable_id_dropped_not_recaptured:ttab_long_gone_1_1/.test(String(deadResolve.refused || '')),
    JSON.stringify(deadResolve))

  // CONTROL B: a live, UNcontradicted id short-circuits and nothing is dropped.
  // Without this, "the marker is written" proves nothing about when.
  mkWorker('w-happy', '[9f31 happy path]')
  setTabId('w-happy', 'ttab_mine_1_1')
  LIVE_TABS = [{ tabId: 'ttab_mine_1_1', label: '[9f31 happy path]', viewColumn: 1, index: 0 }]
  const happy = await coord._captureStableTabId('w-happy')
  ok('CONTROL: a live uncontradicted id short-circuits untouched',
    happy.ok === true && happy.reason === 'already_set' && happy.tabId === 'ttab_mine_1_1',
    JSON.stringify(happy))
  const happyRow = diskRow('w-happy').tab_handle
  ok('CONTROL: nothing was dropped on the happy path',
    happyRow.tabId === 'ttab_mine_1_1' && !happyRow.tabId_stale_dropped
      && !happyRow.tabId_wrong_dropped, JSON.stringify(happyRow))

  // CONTROL C: the fail-safe direction. An empty listing proves nothing, so the
  // stored id must survive. Dropping it there is the mirror-image bug.
  mkWorker('w-dark', '[9f31 bridge dark]')
  setTabId('w-dark', 'ttab_unverifiable_1_1')
  LIVE_TABS = []
  const dark = await coord._captureStableTabId('w-dark')
  ok('CONTROL: an empty listing keeps the stored id',
    dark.ok === true && dark.reason === 'already_set_liveness_unknown', JSON.stringify(dark))
  const darkRow = diskRow('w-dark').tab_handle
  ok('CONTROL: and marks nothing',
    darkRow.tabId === 'ttab_unverifiable_1_1' && !darkRow.tabId_stale_dropped,
    JSON.stringify(darkRow))

  ide.tabs = realTabs
  ide.tabs_close = realClose
  console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'))
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => { console.error('THREW: ' + (e && e.stack || e)); process.exit(1) })
