// Unit test for the 2026-08-29 lane W1 item 1 fix: identify the CONDUCTOR by its
// registered STABLE BRIDGE TAB ID, not by label string equality.
//
//   tools/coord.js  _captureConductorStableTabId  - the CAPTURE half. Stores the
//     id of the tab whose label is being stored as title_match, on every
//     register AND every heartbeat.
//   tools/tab-close-guard.js  evaluateClose belt 2 - the BELT half. Refuses on
//     identity first, label as fallback.
//
// The order matters and both halves ship together: a belt whose new conjunct
// nothing ever populates is a no-op that typechecks (ecodiaos 191a25d76).
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-conductor-stable-id-guard.test.js
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

let fails = 0
const assert = (cond, msg) => { if (cond) { console.log('  PASS: ' + msg) } else { console.log('  FAIL: ' + msg); fails++ } }

const guard = require('./tab-close-guard')
const CC_VT = 'mainThreadWebview-claudeVSCodePanel'

// ── Part 1: belt 2 policy ────────────────────────────────────────────────────
console.log('Part 1: belt 2 decides on identity, falls back to label')

// (a) THE DEFECT FIX. A conductor registered during the ~11s before Claude Code
// autotitles stores the generic "Claude Code" as title_match. Every freshly
// spawned worker tab carries that same label, so the old label-equality belt
// refused every one of their self-closes and they leaked forever. With both ids
// known and different, the tab is provably NOT the conductor and the close runs.
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'Claude Code', active: false, tabId: 'ttab_worker_1_1' },
    { title_match: 'Claude Code', stable_tab_id: 'ttab_conductor_1_1' },
    { selfClose: true })
  assert(d.allow === true,
    'generic label collision with a DIFFERENT stable id is ALLOWED (the leak-amplifier fix)')
})()

// (b) The conductor tab is protected by identity even after Claude Code has
// rewritten its label out from under the stored title_match.
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'On the ecodia site can w…', active: false, tabId: 'ttab_conductor_1_1' },
    { title_match: 'Claude Code', stable_tab_id: 'ttab_conductor_1_1' },
    { selfClose: true })
  assert(d.allow === false, 'stable id equality REFUSES even when the label has changed')
  assert(d.reason === 'conductor_stable_id_protected',
    'reason is conductor_stable_id_protected (got ' + d.reason + ')')
})()

// (c) THE VALVE. A NON-generic label agreeing with the conductor's is real
// evidence, so it still refuses even when the ids disagree. That is the belt
// against a STALE stored id: the bridge re-mints an id for a tab that retitles
// and reorders between two listings.
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'Ecodia Site', active: false, tabId: 'ttab_other_1_1' },
    { title_match: 'Ecodia Site', stable_tab_id: 'ttab_conductor_1_1' },
    { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_label_protected',
    'a NON-generic label match still refuses when the ids disagree (stale-id valve)')
})()

// (d) A caller that supplies no tabId cannot speak the id language. Fall back to
// the label rather than silently dropping the conductor's cover.
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'Claude Code', active: false },
    { title_match: 'Claude Code', stable_tab_id: 'ttab_conductor_1_1' },
    { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_label_protected',
    'a caller with NO tabId falls back to the label belt (fail-safe)')
})()

// (e)+(f) LEGACY UNCHANGED. Every conductor row on disk today has no stable id
// (mac-conductor-2026-06-08.json, current.json), so the label belt must behave
// exactly as it did for them. This is verify-gate item 4.
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'Ecodia Site', active: false, tabId: 'ttab_x_1_1' },
    { title_match: 'Ecodia Site' },
    { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_label_protected',
    'NO stable id on the conductor row: the label belt still protects (non-generic)')
})()
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'Claude Code', active: false, tabId: 'ttab_x_1_1' },
    { title_match: 'Claude Code' },
    { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_label_protected',
    'NO stable id on the conductor row: the label belt still protects (generic too)')
})()

// (g) Belt 2 is unconditional. Self-close waives belts 1 and 3, never this one.
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'anything at all', active: true, tabId: 'ttab_conductor_1_1' },
    { title_match: 'unrelated', stable_tab_id: 'ttab_conductor_1_1' },
    { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_stable_id_protected',
    'the stable-id belt applies on the SELF-close path too')
})()

// (h) Identity beats an otherwise-positive strategy on a sweep path.
;(() => {
  const d = guard.evaluateClose(
    'reaper_anchor_exact_label',
    { label: 'Distilling', active: false, tabId: 'ttab_conductor_1_1' },
    { title_match: '', stable_tab_id: 'ttab_conductor_1_1' })
  assert(d.allow === false && d.reason === 'conductor_stable_id_protected',
    'the reaper cannot close the conductor by identity even with an empty title_match')
})()

// (i) No conductor registered at all: belt 2 is inert, other belts decide.
;(() => {
  const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'Claude Code', active: false, tabId: 't1' }, null)
  assert(d.allow === true, 'no conductor row: belt 2 is inert')
})()

// The generic set is the one belt 2 keys on.
;(() => {
  assert(guard.isGenericLabel('Claude Code') === true, 'isGenericLabel true for "Claude Code"')
  assert(guard.isGenericLabel('  new chat ') === true, 'isGenericLabel is trim + case insensitive')
  assert(guard.isGenericLabel('Ecodia Site') === false, 'isGenericLabel false for a human label')
})()

// (r)+(s) THE NORMALISERS. Belt 2's identity compare trims BOTH sides before it
// compares them, and neither trim had a test. They are the conjunct that decides
// whether an id survives a round trip through a JSON row, a shell, or a bridge
// payload that padded it. Isolate them from the label ladder by giving the
// conductor a title_match that does NOT match the live label: if the trim is
// dropped the ids stop matching, the label cannot cover, and the belt ALLOWS a
// close of the conductor's own tab.
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'Live Retitled Chat', active: false, tabId: 'ttab_cond_1_1' },
    { title_match: 'Old Stored Title', stable_tab_id: '  ttab_cond_1_1  ' },
    { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_stable_id_protected',
    'belt 2 TRIMS the STORED id before comparing (got ' + d.allow + '/' + d.reason + ')')
})()
;(() => {
  const d = guard.evaluateClose(
    'sentinel_prefix:EOS-W-x',
    { label: 'Live Retitled Chat', active: false, tabId: '  ttab_cond_1_1  ' },
    { title_match: 'Old Stored Title', stable_tab_id: 'ttab_cond_1_1' },
    { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_stable_id_protected',
    'belt 2 TRIMS the LIVE tab id before comparing (got ' + d.allow + '/' + d.reason + ')')
})()

// ── Part 2: the CAPTURE half ─────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cond-stable-'))
process.env.COORD_ROOT = tmpRoot
process.env.COORD_DISABLE_SWEEP = '1'

const ide = require('./ide')
let LIVE = []
ide.tabs = async () => ({ groups: [ { viewColumn: 1, tabs: LIVE } ] })
const tab = (id, label, active, index) => ({
  tabId: id, label: label, active: !!active, index: index, viewColumn: 1, viewType: CC_VT,
})

const coord = require('./coord.js')

;(async () => {
  console.log('Part 2: capture stores the id of the tab the LABEL names')

  // (j) The heartbeat hook SUPPLIES title_match, which skips register's bridge
  // probe entirely. That is the common path, so capture must run there too.
  LIVE = [
    tab('ttab_take3_1_1', 'Take3', false, 0),
    tab('ttab_cond_1_1', 'On the ecodia site can w…', false, 1),
    tab('ttab_wrkr_1_1', '[f9b1 coord tab close la…', true, 2),
  ]
  let res = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 45955, ide_pid: 87491,
    title_match: 'On the ecodia site can w…',
  })
  assert(res.conductor.stable_tab_id === 'ttab_cond_1_1',
    'register with a CALLER-SUPPLIED title_match still captures the stable id (got ' + res.conductor.stable_tab_id + ')')

  // The trap this design exists to dodge: the ACTIVE tab here is a dispatched
  // worker, not the conductor. Capturing by activeness would store the worker's
  // id and make that worker permanently unclosable.
  assert(res.conductor.stable_tab_id !== 'ttab_wrkr_1_1',
    'capture does NOT take the ACTIVE tab when the active tab is a worker')

  // (k) Truncation-aware. Claude Code renders a long label as 24 chars + U+2026,
  // so a full caller-supplied title_match is LONGER than the live label.
  LIVE = [ tab('ttab_long_1_1', 'A very long conductor ch…', false, 0) ]
  res = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 45955,
    title_match: 'A very long conductor chat title that CC truncated',
  })
  assert(res.conductor.stable_tab_id === 'ttab_long_1_1',
    'capture is truncation-aware (full title_match vs a rendered live label)')

  // (l) A worker-shaped title_match never names the conductor. The title_match
  // write already rejects it; the id must be rejected in lockstep or the two
  // halves of belt 2 could point at different tabs.
  LIVE = [ tab('ttab_poison_1_1', '[status board execute top]', true, 0) ]
  res = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 45955,
    title_match: '[status board execute top]',
  })
  assert(res.conductor.stable_tab_id === 'ttab_long_1_1',
    'a worker-shaped title_match captures NO id and keeps the prior (got ' + res.conductor.stable_tab_id + ')')

  // (m) Two tabs wear the label and neither is active: undecidable. Keep the
  // prior id. REPLACE-ONLY - never demote a row that has an id to having none,
  // because belt 2 reads "no id" as permission to decide on the label alone.
  LIVE = [ tab('ttab_a_1_1', 'Claude Code', false, 0), tab('ttab_b_1_1', 'Claude Code', false, 1) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  let st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_long_1_1',
    'an AMBIGUOUS label keeps the prior id rather than blanking it (got ' + st.conductor.stable_tab_id + ')')

  // ...but when exactly one of them is the focused tab, that tie breaks.
  LIVE = [ tab('ttab_a_1_1', 'Claude Code', false, 0), tab('ttab_b_1_1', 'Claude Code', true, 1) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_b_1_1',
    'a tie between same-label tabs breaks on the ACTIVE one (got ' + st.conductor.stable_tab_id + ')')

  // NOT gated on genericness: "Claude Code" is exactly the window the id is most
  // needed in, so a genericness gate at CAPTURE would leave belt 2 with nothing
  // to compare in the only window the amplifier is live.
  assert(st.conductor.stable_tab_id === 'ttab_b_1_1',
    'capture runs for a GENERIC label too (the amplifier window needs an id most)')

  // (n) A bridge failure proves nothing. Keep what we had.
  const realTabs = ide.tabs
  ide.tabs = async () => { throw new Error('bridge down') }
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_b_1_1', 'a bridge ERROR keeps the stored id untouched')
  ide.tabs = async () => ({ groups: [] })
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_b_1_1', 'an EMPTY listing keeps the stored id untouched')
  ide.tabs = realTabs

  // (o) The bridge RE-MINTS an id when a tab retitles and reorders, so the
  // heartbeat must refresh, not just register once.
  LIVE = [ tab('ttab_reminted_1_1', 'Claude Code', true, 3) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_reminted_1_1',
    'the heartbeat REFRESHES the id when the bridge re-mints one (got ' + st.conductor.stable_tab_id + ')')

  // (p) No tab wears the stored label: keep the prior id.
  LIVE = [ tab('ttab_zzz_1_1', 'Something Else', true, 0) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_reminted_1_1', 'NO label match keeps the prior id')

  // (q) A tab a WORKER row already owns is that worker's, not the conductor's.
  // Without this, a generic label would hand a just-spawned worker's tab to the
  // conductor slot and make that worker permanently unclosable - the exact
  // amplifier this whole change removes, re-entering through capture.
  fs.mkdirSync(path.join(tmpRoot, 'workers'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'workers', 'tab_w1.json'), JSON.stringify({
    tab_id: 'tab_w1', tab_handle: { tabId: 'ttab_claimed_1_1', viewColumn: 1 },
  }))
  LIVE = [ tab('ttab_claimed_1_1', 'Claude Code', true, 0) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_reminted_1_1',
    'a tab CLAIMED by a worker row is never captured as the conductor (got ' + st.conductor.stable_tab_id + ')')

  // (r) THE HOLE IN (q). A worker's row claims nothing until dispatch_worker
  // captures its tab_handle, measured 3.79-8.33s after registration (median
  // 5.55s, n=29). For that whole window the worker's tab wears the generic spawn
  // label AND is the focused tab, because a new tab steals focus. So the (q)
  // filter, which is the ONLY thing standing between a generic probe and a
  // worker's id, is blind for exactly as long as the tab is most confusable.
  // Two doors, and the tiebreak one is only the first.
  const pendingWorker = (regAtMs) => fs.writeFileSync(
    path.join(tmpRoot, 'workers', 'tab_pending.json'), JSON.stringify({
      tab_id: 'tab_pending', terminated_at: null, tab_handle: null,
      registered_at: new Date(regAtMs).toISOString(),
    }))
  const dropPendingWorker = () => { try { fs.unlinkSync(path.join(tmpRoot, 'workers', 'tab_pending.json')) } catch (e) {} }

  // DOOR 1: the same-label tiebreak hands the conductor slot to the FOCUSED
  // worker. Pre-fix this captured ttab_spawn_1_1 and belt 2 then ALLOWED the
  // close of the live conductor tab.
  pendingWorker(Date.now() - 4000)
  LIVE = [ tab('ttab_cond_r_1_1', 'Claude Code', false, 0), tab('ttab_spawn_1_1', 'Claude Code', true, 1) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_reminted_1_1',
    'DOOR 1: a generic probe taken while a worker is pre-tab_handle keeps the PRIOR id (got ' + st.conductor.stable_tab_id + ')')

  // DOOR 2: no tiebreak is involved at all. The conductor has already autotitled
  // so it no longer wears the stale-generic title_match, leaving the spawning
  // worker as the SINGLE hit, returned directly.
  LIVE = [ tab('ttab_cond_r_1_1', 'Studio', false, 0), tab('ttab_spawn_1_1', 'Claude Code', true, 1) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_reminted_1_1',
    'DOOR 2: a SINGLE generic hit that is a spawning worker is not captured either (got ' + st.conductor.stable_tab_id + ')')

  // The helper's own contract, so the reason is pinned and not inferred.
  ;(() => {
    const r = coord._hasSpawningUnclaimedWorker()
    assert(r === true, 'the spawn-window predicate SEES a row that has no tab_handle yet')
  })()

  // The predicate reads TWO populations and a test that drives only one leaves
  // the other undefended (measured: disabling the in-memory branch left all 11
  // suites green). A live worker sits in the in-memory map AND is skipped by the
  // on-disk loop precisely because it is in the map, so the map branch is the
  // only thing covering a worker that registered this process.
  ;(() => {
    dropPendingWorker()
    assert(coord._hasSpawningUnclaimedWorker() === false, 'premise: no pending worker before the in-memory register')
    coord._registerWorkerInternal({ tab_id: 'tab_inmem', task_id: 'tm1', tab_credential: 'cred-inmem' })
    assert(coord._hasSpawningUnclaimedWorker() === true,
      'the predicate sees a worker held in the IN-MEMORY map, not just one on disk')
  })()
  LIVE = [ tab('ttab_cond_r_1_1', 'Claude Code', false, 0), tab('ttab_spawn_1_1', 'Claude Code', true, 1) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_reminted_1_1',
    'DOOR 1 via the IN-MEMORY registry: prior id kept (got ' + st.conductor.stable_tab_id + ')')
  coord._workersMap().delete('tab_inmem')
  try { fs.unlinkSync(path.join(tmpRoot, 'workers', 'tab_inmem.json')) } catch (e) {}
  assert(coord._hasSpawningUnclaimedWorker() === false, 'cleanup: the in-memory worker is gone')

  // (s) ANTI-OVERREACH A: this must not become a blanket genericness gate.
  // Outside the spawn window a generic label still captures, which is the
  // author's line-238 point and it stands: that window is where belt 2 needs an
  // id most, and declining there would strand the conductor with neither an id
  // nor a matching label the moment Claude Code autotitles it.
  pendingWorker(Date.now() - 10 * 60 * 1000)   // aged past SPAWN_HANDLE_GRACE_MS
  assert(coord._hasSpawningUnclaimedWorker() === false,
    'a row aged past the grace window no longer blocks capture (nothing stamps terminated_at on a died-at-spawn row)')
  LIVE = [ tab('ttab_aged_1_1', 'Claude Code', true, 0) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_aged_1_1',
    'ANTI-OVERREACH: capture still runs for a GENERIC label outside the spawn window (got ' + st.conductor.stable_tab_id + ')')

  // A TERMINATED row does not block either.
  fs.writeFileSync(path.join(tmpRoot, 'workers', 'tab_pending.json'), JSON.stringify({
    tab_id: 'tab_pending', terminated_at: new Date().toISOString(), tab_handle: null,
    registered_at: new Date().toISOString(),
  }))
  assert(coord._hasSpawningUnclaimedWorker() === false, 'a TERMINATED pre-handle row does not block capture')

  // (t) ANTI-OVERREACH B: a NON-generic title_match is unaffected by the spawn
  // window. A spawning worker wears the generic label, so it cannot be the hit.
  pendingWorker(Date.now() - 3000)
  LIVE = [ tab('ttab_ng_cap_1_1', 'Ecodia Site', true, 0), tab('ttab_spawn_1_1', 'Claude Code', false, 1) ]
  await coord.conductor_heartbeat({ title_match: 'Ecodia Site' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_ng_cap_1_1',
    'ANTI-OVERREACH: a NON-generic label captures normally while a worker spawns (got ' + st.conductor.stable_tab_id + ')')
  dropPendingWorker()

  // Restore the id the rest of this script expects.
  LIVE = [ tab('ttab_reminted_1_1', 'Claude Code', true, 0) ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_reminted_1_1', 'capture restored for the remainder of the script')

  // ── Part 2b: the helper's OWN contract ────────────────────────────────────
  // Parts 2's assertions go through register_conductor / conductor_heartbeat,
  // and BOTH callers already sanitise a worker-shaped title_match upstream and
  // both assign only on a truthy id. So a test driven through them passes with
  // or without the helper's own rejection and its own replace-only return - it
  // is defended by someone else's conjunct, which is the specimen trap this
  // lane's brief names. Drive the exported helper directly so each conjunct is
  // tested where it lives.
  console.log("Part 2b: _captureConductorStableTabId's own contract")
  const cap = coord._captureConductorStableTabId
  assert(typeof cap === 'function', 'the capture helper is exported')

  LIVE = [ tab('ttab_sentinel_1_1', '[status board execute top]', true, 0) ]
  let r = await cap('[status board execute top]', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'worker_shaped_label',
    'the helper REFUSES a worker-shaped label itself and returns the prior id')

  LIVE = [ tab('ttab_ok_1_1', 'Ecodia Site', true, 0) ]
  r = await cap('Ecodia Site', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_ok_1_1', 'the helper captures on a clean unique label match')

  const savedTabs = ide.tabs
  ide.tabs = async () => { throw new Error('bridge down') }
  r = await cap('Ecodia Site', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'bridge_unreachable',
    'REPLACE-ONLY: a bridge throw returns the PRIOR id, never null')
  ide.tabs = async () => ({ groups: [] })
  r = await cap('Ecodia Site', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'no_live_tabs',
    'REPLACE-ONLY: an empty listing returns the PRIOR id, never null')
  ide.tabs = savedTabs

  LIVE = [ tab('ttab_else_1_1', 'Something Else', true, 0) ]
  r = await cap('Ecodia Site', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'no_label_match',
    'REPLACE-ONLY: no label match returns the PRIOR id, never null')

  r = await cap('Ecodia Site', null, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'no_ide_port',
    'REPLACE-ONLY: no ide port returns the PRIOR id')
  r = await cap('   ', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'no_title_match',
    'REPLACE-ONLY: a blank title_match returns the PRIOR id')

  // The three replace-only branches that had NO assertion anywhere (mutated
  // 2026-08-29 lane W1 item 2 verification: prior -> null on each, and not one
  // suite went red). All three are LEAK-only on their own - a null id demotes
  // belt 2 to the label ladder, which refuses - but they are also the branches
  // that HOLD an id, so they are exactly what turns a bad seed into a permanent
  // one. That is the interaction with the takeover fix in Part 2c.

  // AMBIGUOUS. Several tabs wear the label and none is focused, so the tie
  // cannot break. This is the branch a GENERIC title_match reaches by
  // construction, every single probe, because every fresh CC tab reads
  // "Claude Code".
  LIVE = [ tab('ttab_am1_1_1', 'Ecodia Site', false, 0), tab('ttab_am2_1_1', 'Ecodia Site', false, 1) ]
  r = await cap('Ecodia Site', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'ambiguous_label',
    'REPLACE-ONLY: an ambiguous label returns the PRIOR id, never null')

  // ALL CLAIMED. Every tab wearing the label is already owned by a worker row.
  // _claimedStableTabIds deliberately does NOT filter terminated rows (a corpse
  // still owns its tab), and terminated rows accumulate, so this branch gets
  // MORE reachable with every dispatch the fleet runs. tab_w1.json from (q)
  // above is the claimant.
  LIVE = [ tab('ttab_claimed_1_1', 'Ecodia Site', true, 0) ]
  r = await cap('Ecodia Site', 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'all_claimed_by_workers',
    'REPLACE-ONLY: every hit claimed by a worker returns the PRIOR id, never null')

  // THREW. The catch-all. A probe that blew up decided nothing, so it must not
  // be read as a decision to blank the id. Forced deterministically through the
  // String() coercion at the top of the helper, which sits outside every inner
  // try - a malformed bridge payload degrades to no_live_tabs rather than
  // throwing, so it cannot exercise this branch.
  const boom = { toString: function () { throw new Error('coercion blew up') } }
  r = await cap(boom, 7457, 'ttab_prior_1_1')
  assert(r.tabId === 'ttab_prior_1_1' && r.reason === 'threw',
    'REPLACE-ONLY: a THROW returns the PRIOR id, never null (got ' + r.tabId + '/' + r.reason + ')')

  // ── Part 2c: a TAKEOVER must not inherit identity from the row it archives ──
  // The defect this part exists for (2026-08-29 lane W1 item 2). register_
  // conductor archives the old row when claude_port differs, and then seeded the
  // NEW row's stable_tab_id from that archived row. Replace-only then HELD the
  // dead tab's id through every undecidable probe. Belt 2 compared a stale sid
  // against the live conductor's tid, found them unequal, saw a generic label
  // that is evidence of nothing, and ALLOWED the close of the live conductor.
  //
  // A wrong-close, not a leak. Every other failure in this subsystem leaks; this
  // one was the single path that could close Tate's live chat, and the generic
  // title_match that makes it reachable is the COMMON registration, not a corner.
  console.log('Part 2c: a takeover starts from no id, it does not inherit one')

  // Establish an old conductor with a decidable, uniquely-labelled tab.
  LIVE = [ tab('ttab_old_cond_1_1', 'Old Conductor Chat', true, 0) ]
  let t = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 11111,
    title_match: 'Old Conductor Chat',
  })
  assert(t.conductor.stable_tab_id === 'ttab_old_cond_1_1',
    'takeover setup: the OLD conductor holds its own id (got ' + t.conductor.stable_tab_id + ')')

  // Now a DIFFERENT chat takes over, registering in the ~11s generic-label
  // window, with two tabs wearing that label and neither focused. Undecidable by
  // construction - which is the whole point, because a generic label makes it
  // undecidable on EVERY probe, not just this one.
  LIVE = [ tab('ttab_new_cond_1_1', 'Claude Code', false, 0), tab('ttab_bystander_1_1', 'Claude Code', false, 1) ]
  t = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 22222,
    title_match: 'Claude Code',
  })
  assert(t.took_over === true, 'takeover premise: a differing claude_port archives the old row')
  assert(!t.conductor.stable_tab_id,
    'a TAKEOVER does not inherit the archived row\'s stable id (got ' + t.conductor.stable_tab_id + ')')

  // THE GATE, at the level the fix actually lives. Ask the guard the question
  // every close path asks about the LIVE conductor tab. Before the fix the row
  // carried ttab_old_cond_1_1, the ids disagreed, the label was generic, and this
  // returned allow=true - a wrong-close of the live conductor chat.
  ;(() => {
    const d = guard.evaluateClose(
      'sentinel_prefix:EOS-W-x',
      { label: 'Claude Code', active: false, tabId: 'ttab_new_cond_1_1' },
      t.conductor, { selfClose: true })
    assert(d.allow === false,
      'post-takeover: the LIVE conductor tab is REFUSED, not closed (got ' + d.allow + '/' + d.reason + ')')
  })()

  // THE CONTROL the brief names: the same takeover with a NON-generic
  // title_match must STAY refusing. It refuses either way - by the label ladder
  // when there is no id, by the non-generic valve when there is - and that is
  // the point: the fix moves nothing here.
  LIVE = [ tab('ttab_ng1_1_1', 'Ecodia Site', false, 0), tab('ttab_ng2_1_1', 'Ecodia Site', false, 1) ]
  t = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 33333,
    title_match: 'Ecodia Site',
  })
  ;(() => {
    const d = guard.evaluateClose(
      'sentinel_prefix:EOS-W-x',
      { label: 'Ecodia Site', active: false, tabId: 'ttab_ng1_1_1' },
      t.conductor, { selfClose: true })
    assert(d.allow === false && d.reason === 'conductor_label_protected',
      'NON-generic control: a takeover with a real label still REFUSES (got ' + d.allow + '/' + d.reason + ')')
  })()

  // The fix must not overreach in the other direction. A takeover whose capture
  // CAN decide still gets an id - the right one, from the new tab.
  LIVE = [ tab('ttab_fresh_cond_1_1', 'Fresh Conductor', true, 0) ]
  t = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 44444,
    title_match: 'Fresh Conductor',
  })
  assert(t.conductor.stable_tab_id === 'ttab_fresh_cond_1_1',
    'a takeover with a DECIDABLE probe captures the NEW id (got ' + t.conductor.stable_tab_id + ')')

  // ...and replace-only itself is untouched on the NON-takeover path. Same
  // claude_port, undecidable probe: the row keeps the id it had. Writing the fix
  // as an unconditional `= null` would pass every assertion above and fail this
  // one, which is what makes it the anti-overreach control.
  LIVE = [ tab('ttab_ra_1_1', 'Claude Code', false, 0), tab('ttab_rb_1_1', 'Claude Code', false, 1) ]
  t = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 44444,
    title_match: 'Claude Code',
  })
  assert(t.took_over === false, 'anti-overreach premise: the same claude_port is NOT a takeover')
  assert(t.conductor.stable_tab_id === 'ttab_fresh_cond_1_1',
    'REPLACE-ONLY survives on the non-takeover path (got ' + t.conductor.stable_tab_id + ')')

  // ── Part 3: the two halves, end to end ─────────────────────────────────────
  console.log('Part 3: capture + belt together on the real close decision')

  // Re-point the conductor at a real tab, then ask the guard the question the
  // close paths ask: may this worker close its own generic-labelled tab?
  LIVE = [
    tab('ttab_cond2_1_1', 'Claude Code', true, 0),
    tab('ttab_wrk2_1_1', 'Claude Code', false, 1),
  ]
  await coord.conductor_heartbeat({ title_match: 'Claude Code' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.stable_tab_id === 'ttab_cond2_1_1', 'end-to-end: conductor id captured')

  const workerClose = guard.evaluateClose(
    'sentinel_prefix:EOS-W-f9b1',
    { label: 'Claude Code', active: false, tabId: 'ttab_wrk2_1_1' },
    st.conductor, { selfClose: true })
  assert(workerClose.allow === true,
    'end-to-end: the worker CAN now close its own generic-labelled tab')

  const conductorClose = guard.evaluateClose(
    'sentinel_prefix:EOS-W-f9b1',
    { label: 'Claude Code', active: true, tabId: 'ttab_cond2_1_1' },
    st.conductor, { selfClose: true })
  assert(conductorClose.allow === false && conductorClose.reason === 'conductor_stable_id_protected',
    'end-to-end: the SAME call against the conductor tab is refused by identity')

  // ── Part 4: every close path actually SUPPLIES a tabId ────────────────────
  // Belt 2's identity conjunct is only live on a path that hands it one. A guard
  // whose new predicate nothing populates is a no-op that typechecks
  // (ecodiaos 191a25d76), so assert the wiring at the source, not just the policy.
  //
  // Two shapes reach the guard. Some call sites forward a RAW bridge tab object,
  // which carries tabId natively (close_my_tab foundExact, cowork kill_worker
  // foundExact, cowork cleanup match off ctx.ccTabs). The rest build a literal,
  // and those must name tabId explicitly - they are the ones checked here.
  console.log('Part 4: the constructed call sites supply a tabId')
  const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8')
  ;(() => {
    const c = src('coord.js')
    assert(/label: anchorTarget\.label,[\s\S]{0,160}?tabId: anchorTarget\.tabId/.test(c),
      '_closeAnchorTarget passes tabId to evaluateClose')
    assert(/_resolveAnchorToTab[\s\S]*?tabId: ccHits\[0\]\.tabId/.test(c),
      'the anchor target object carries tabId out of the bridge probe')
    assert(/label: tab\.label, index: tab\.index, viewColumn: tab\.viewColumn, active: tab\.active, tabId: tab\.tabId/.test(c),
      '_closeStableIdTarget passes tabId to evaluateClose')
  })()
  ;(() => {
    const r = src('reap-leaked-worker-tabs.js')
    assert(/evaluateClose\('reaper_anchor_exact_label',[\s\S]{0,400}?tabId: tab\.tabId/.test(r),
      'the leaked-tab reaper passes the LIVE tab\'s tabId to evaluateClose')
  })()
  // The raw-object paths: assert the object handed over is the bridge tab itself,
  // so tabId rides along without threading.
  ;(() => {
    const c = src('coord.js')
    assert(/evaluateClose\(matchedBy, foundExact, conductor, GUARD_SELF_CLOSE\)/.test(c),
      'close_my_tab hands the RAW bridge tab (foundExact) to the guard')
    const w = src('cowork.js')
    assert(/evaluateClose\(matchedBy, foundExact, conductorRow\)/.test(w),
      'cowork.kill_worker hands the RAW bridge tab to the guard')
    assert(/evaluateClose\(strategy, match, conductorRowForGuard\)/.test(w),
      'cowork.cleanup_orphan_workers hands the RAW bridge tab to the guard')
    assert(/ccTabs: \(g\.tabs \|\| \[\]\)\.filter\(t => t\.viewType === CC_CHAT_VIEW_TYPE\)/.test(w),
      'cowork ccTabs is an unmapped filter, so tabId survives into match')
  })()

  // ── Part 5: the reaper's tabId, tested by BEHAVIOUR not by grep ───────────
  // reap-leaked-worker-tabs.js:~208 `tabId: tab.tabId || ttab || null` was added
  // by the item-1 commit itself and nothing tested it. The Part 4 assertion above
  // is a source grep, and a source grep cannot tell `tabId: tab.tabId` from
  // `tabId: null` unless it names the expression - which is why it now does. This
  // part is the behavioural half: drive the real script, on the real guard, and
  // assert the conductor's tab is PRESERVED by identity.
  //
  // The scenario is the one the identity conjunct exists for and the ONLY one
  // where it is load-bearing in this script: Claude Code has retitled the
  // conductor's chat, so the stored title_match no longer equals the live label
  // and the label ladder cannot cover. A stale worker anchor happens to carry
  // that new label. Without a tabId the guard has nothing left and ALLOWS the
  // close of the conductor.
  //
  // The stubs are written to a TEMP dir and preloaded with -r. They must never
  // land in tools/: index.js autoloads every .js there (lib/tool-autoload.js,
  // and its skip regex covers test-harness names only), so a committed stub that
  // overwrites ide.tabs would break every capture and close path in the live
  // agent at the next boot. That is this very script's own 2026-08-29 P0.
  console.log('Part 5: the leaked-tab reaper preserves the conductor by identity')
  const { execFileSync } = require('child_process')
  const reapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-fix-'))
  const REAP_TTAB = 'ttab_cond_reap_1_1'
  const REAP_LABEL = 'Reaper Live Label'
  fs.mkdirSync(path.join(reapRoot, 'conductors'), { recursive: true })
  fs.mkdirSync(path.join(reapRoot, 'workers'), { recursive: true })
  fs.mkdirSync(path.join(reapRoot, 'chat-tabs'), { recursive: true })
  fs.writeFileSync(path.join(reapRoot, 'conductors', 'current.json'), JSON.stringify({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 1,
    // RETITLED: the stored label is stale, so the label ladder is out of the game.
    title_match: 'Old Stored Conductor Title',
    stable_tab_id: REAP_TTAB,
  }))
  fs.writeFileSync(path.join(reapRoot, 'workers', 'tab_reapw.json'), JSON.stringify({
    tab_id: 'tab_reapw', terminated_at: '2026-08-29T00:00:00.000Z',
  }))
  fs.writeFileSync(path.join(reapRoot, 'chat-tabs', 'tab_reapw.json'), JSON.stringify({
    tab_id: 'tab_reapw', role: 'worker', label: REAP_LABEL, session_id: 'sess_reapw',
  }))
  const preload = path.join(reapRoot, 'stub-bridge.js')
  fs.writeFileSync(preload, [
    "'use strict'",
    'const path = require("path")',
    'const TOOLS = ' + JSON.stringify(__dirname),
    'const CC = ' + JSON.stringify(CC_VT),
    'const ide = require(path.join(TOOLS, "ide.js"))',
    'ide.tabs = async function () { return { groups: [ { viewColumn: 1, tabs: [',
    '  { tabId: ' + JSON.stringify(REAP_TTAB) + ', label: ' + JSON.stringify(REAP_LABEL) + ', active: false, index: 0, viewType: CC },',
    '] } ] } }',
    'const liveness = require(path.join(TOOLS, "worker-liveness.js"))',
    'liveness.liveTabs = function () { return new Map() }',
    '',
  ].join('\n'))
  let reapReport = null
  let reapErr = null
  try {
    const out = execFileSync(process.execPath,
      ['-r', preload, path.join(__dirname, 'reap-leaked-worker-tabs.js')],
      { env: Object.assign({}, process.env, { COORD_ROOT: reapRoot, COORD_DISABLE_SWEEP: '1' }),
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    reapReport = JSON.parse(out)
  } catch (e) { reapErr = (e && (e.stderr || e.message)) || String(e) }
  assert(reapReport !== null, 'the reaper dry-run produced a JSON report (err=' + reapErr + ')')
  if (reapReport) {
    // Premise first: without this the assertions below pass vacuously on a report
    // that never reached the guard at all.
    assert(reapReport.live_tabs_seen === 1, 'reaper premise: the stubbed bridge listing reached it')
    const reasons = (reapReport.preserved || []).map((x) => x.reason)
    assert(reasons.indexOf('close_guard:conductor_stable_id_protected') !== -1,
      'the reaper PRESERVES the conductor tab by stable id (preserved=' + JSON.stringify(reasons) + ')')
    assert((reapReport.candidates || []).length === 0,
      'the reaper proposes NOTHING to close (candidates=' + JSON.stringify(reapReport.candidates) + ')')
  }
  try { fs.rmSync(reapRoot, { recursive: true, force: true }) } catch (e) {}

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  if (fails === 0) { console.log('ALL TESTS PASSED'); process.exit(0) } else { console.log(fails + ' TEST(S) FAILED'); process.exit(1) }
})()
