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
    assert(/evaluateClose\('reaper_anchor_exact_label',[\s\S]{0,400}?tabId:/.test(r),
      'the leaked-tab reaper passes tabId to evaluateClose')
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

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  if (fails === 0) { console.log('ALL TESTS PASSED'); process.exit(0) } else { console.log(fails + ' TEST(S) FAILED'); process.exit(1) }
})()
