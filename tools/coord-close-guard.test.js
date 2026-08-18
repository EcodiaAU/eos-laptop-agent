// Unit test for the 2026-07-21 THIRD + complete conductor-tab-death fix:
//   tools/tab-close-guard.js  - positive-identity close policy (the belt shared
//                               by close_my_tab / kill_worker / cleanup)
//   coord.register_conductor  - now captures a REAL title_match from the IDE
//                               bridge (was "" -> the conductor_label belt was a
//                               permanent no-op).
// Run: node tools/coord-close-guard.test.js
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

let fails = 0
const assert = (cond, msg) => { if (cond) { console.log('  PASS: ' + msg) } else { console.log('  FAIL: ' + msg); fails++ } }

// ── Part 1: tab-close-guard.evaluateClose policy ────────────────────────────
const guard = require('./tab-close-guard')

// Positive tiers close a backgrounded tab.
;(() => {
  const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'EOS-W-x work', active: false }, null)
  assert(d.allow === true, 'positive sentinel match on a backgrounded tab is allowed')
})()
;(() => {
  const d = guard.evaluateClose('tabIndex+sentinel:0', { label: 'EOS-W-x work', active: false }, null)
  assert(d.allow === true, 'positive tabIndex+sentinel match is allowed')
})()

// The load-bearing belt: a FUZZY autotitle-fingerprint match NEVER closes, even
// backgrounded, even with no conductor registered. This is the human-chat guard.
;(() => {
  const d = guard.evaluateClose('autotitle_fingerprint:hits=2/2,cov=1.00', { label: 'Ecodia Site', active: false }, null)
  assert(d.allow === false, 'fuzzy autotitle-fingerprint match is REFUSED')
  assert(d.reason === 'fuzzy_fingerprint_refused_not_positive_id', 'reason is fuzzy_fingerprint_refused_not_positive_id (got ' + d.reason + ')')
})()
;(() => {
  const d = guard.evaluateClose('autotitle_hits=2', { label: 'DayCrew', active: false }, null)
  assert(d.allow === false, 'the bare autotitle_ reason prefix is also refused')
})()

// The active belt still fires (focused tab is never a dead orphan), and takes
// precedence over even a positive strategy - on the SWEEP paths, which pass no
// opts (kill_worker, cleanup_orphan_workers). This is the 2026-07-21 belt and
// the self-close exception below must not widen it.
;(() => {
  const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'EOS-W-x work', active: true }, null)
  assert(d.allow === false && d.reason === 'active_tab_protected', 'active tab is refused even on a positive strategy')
})()

// ── Self-close exception (2026-07-22, widened 2026-08-15) ───────────────────
// coord.close_my_tab passes { selfClose: true }. A worker self-closing is a tab
// making a tool call, so its focus state says nothing about whether it is a
// human chat, and the unconditional belt-1 refused every self-close and leaked
// every worker tab. 2026-07-22 admitted a POSITIVE self-close; 2026-08-15
// (Tate-authorised full fix) widens the carve-out so self-close ALSO admits the
// decisive fuzzy tier - CC's improved autotitler strips the spawn sentinel, so
// the fingerprint is the only surviving resolver, and on self-close the worker's
// own live tab is the natural top scorer. Belts waived on self-close: 1 (active)
// and 3 (fuzzy). Belt 2 (conductor label) ALWAYS applies. Sweeps keep both belts.

// The leak case that motivated this: positive + active + selfClose -> ALLOW.
// Both tiers that real workers were refused on, on 2026-07-22.
;(() => {
  const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'EOS-W-x work', active: true }, null, { selfClose: true })
  assert(d.allow === true, 'self-close on sentinel_prefix closes its own active tab (96655d81 leak)')
})()
;(() => {
  const d = guard.evaluateClose('tabIndex+sentinel:5', { label: 'EOS-W-x work', active: true }, null, { selfClose: true })
  assert(d.allow === true, 'self-close on tabIndex+sentinel closes its own active tab (00c3b66f leak)')
})()

// 2026-08-15 carve-out: self-close ADMITS the decisive fuzzy tier (the worker's
// own retitled tab), both active and backgrounded. This is the "Advance away-ops
// runbook v2" leak - CC autotitled away the spawn sentinel, so only the
// fingerprint (4/4, cov 1.00) resolved, and the old belt-3 refused it. On
// self-close the worker's own tab is the top scorer and coord.js tier (d) only
// forwards a UNIQUE DECISIVE winner, so admitting it here is safe.
;(() => {
  const d = guard.evaluateClose('autotitle_fingerprint:hits=4/4,cov=1.00', { label: 'Advance away-ops runbook v2', active: false }, null, { selfClose: true })
  assert(d.allow === true, 'self-close admits the decisive fuzzy match on a backgrounded own tab (the leak this fixes)')
})()
;(() => {
  const d = guard.evaluateClose('autotitle_fingerprint:hits=4/4,cov=1.00', { label: 'Advance away-ops runbook v2', active: true }, null, { selfClose: true })
  assert(d.allow === true, 'self-close admits the decisive fuzzy match on a foreground own tab too')
})()

// SWEEP paths still hard-ban fuzzy (the 2026-07-21 invariant is UNCHANGED there):
// the same fuzzy match with no selfClose opts must stay refused.
;(() => {
  const d = guard.evaluateClose('autotitle_fingerprint:hits=4/4,cov=1.00', { label: 'Advance away-ops runbook v2', active: false }, null)
  assert(d.allow === false && d.reason === 'fuzzy_fingerprint_refused_not_positive_id', 'sweep paths STILL refuse the identical fuzzy match (no selfClose)')
})()

// Belt 2 is the load-bearing safety that SURVIVES the carve-out: a fuzzy
// self-close that resolves onto the registered conductor's chat must STILL be
// refused, even though fuzzy is otherwise admitted on self-close. This is the
// case that would re-close Tate's live chat if the carve-out were unbounded.
;(() => {
  const d = guard.evaluateClose('autotitle_fingerprint:hits=2/2,cov=1.00', { label: 'Ecodia Site', active: true }, { title_match: 'Ecodia Site' }, { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_label_protected', 'self-close fuzzy onto the conductor label is STILL refused (belt 2 survives)')
})()

// The conductor belt survives on a positive strategy too (unchanged).
;(() => {
  const d = guard.evaluateClose('exact_label:Ecodia Site', { label: 'Ecodia Site', active: true }, { title_match: 'Ecodia Site' }, { selfClose: true })
  assert(d.allow === false && d.reason === 'conductor_label_protected', 'self-close never closes the registered conductor tab')
})()

// The sweep paths are unchanged by the new arg: absent/false/empty opts all
// keep the unconditional belt, so kill_worker and cleanup cannot inherit this.
;(() => {
  for (const opts of [undefined, null, {}, { selfClose: false }]) {
    const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'EOS-W-x work', active: true }, null, opts)
    assert(d.allow === false && d.reason === 'active_tab_protected', 'sweep paths keep the unconditional active belt (opts=' + JSON.stringify(opts) + ')')
  }
})()

// A backgrounded positive self-close was already allowed and must stay allowed.
;(() => {
  const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'EOS-W-x work', active: false }, null, { selfClose: true })
  assert(d.allow === true, 'backgrounded positive self-close still allowed')
})()

// The conductor-label belt fires once title_match is a real string (backgrounded,
// positive strategy) - proves the belt has teeth after the register fix.
;(() => {
  const d = guard.evaluateClose('exact_label:Ecodia Site', { label: 'Ecodia Site', active: false }, { title_match: 'Ecodia Site' })
  assert(d.allow === false && d.reason === 'conductor_label_protected', 'registered-conductor label is refused (belt has teeth)')
})()
// Empty title_match never matches (the pre-fix no-op state must stay a no-op).
;(() => {
  const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'EOS-W-x work', active: false }, { title_match: '' })
  assert(d.allow === true, 'empty conductor title_match does not block a positive worker close')
})()

assert(guard.isFuzzyStrategy('autotitle_fingerprint') === true, 'isFuzzyStrategy true for autotitle_')
assert(guard.isFuzzyStrategy('sentinel_prefix:x') === false, 'isFuzzyStrategy false for sentinel_prefix')

// ── Part 2: register_conductor captures a real title_match from the bridge ───
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-cond-'))
process.env.COORD_ROOT = tmpRoot
process.env.COORD_DISABLE_SWEEP = '1'

const ide = require('./ide')
const CC_VT = 'mainThreadWebview-claudeVSCodePanel'
// Stub the bridge probe: the active CC panel tab is "theres like 1cm room lef…".
ide.tabs = async () => ({ groups: [ { viewColumn: 1, tabs: [
  { viewType: CC_VT, viewColumn: 1, index: 0, label: 'Budgetting', active: false },
  { viewType: CC_VT, viewColumn: 1, index: 1, label: 'theres like 1cm room lef…', active: true },
] } ] })

const coord = require('./coord.js')
;(async () => {
  const res = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 45955, ide_pid: 87491,
  })
  assert(res.ok === true, 'register_conductor returns ok')
  assert(res.conductor.title_match === 'theres like 1cm room lef…',
    'register_conductor captured the ACTIVE CC tab label as title_match (got "' + res.conductor.title_match + '")')

  // ── Part 3: title_match rejects worker-sentinel-shaped values ──────────────
  // Root cause of the 2026-08-18 leaked-tab report: a worker's "[...]" dispatch
  // sentinel leaked into conductor.title_match, and tab-close-guard belt 2 then
  // refused that worker's OWN positive sentinel self-close. The write chokepoint
  // (register_conductor + conductor_heartbeat) must never store a worker-shaped
  // label. Doctrine: coord-conductor-title-match-rejects-worker-sentinel-2026-08-18.

  // Baseline: a real human label persists (set via heartbeat).
  await coord.conductor_heartbeat({ title_match: 'Autonomy' })
  let st = await coord.get_conductor_state({})
  assert(st.conductor.title_match === 'Autonomy', 'heartbeat stores a real human chat-tab label')

  // A "[worker sentinel]" heartbeat is IGNORED - the good label survives.
  await coord.conductor_heartbeat({ title_match: '[status board execute top]' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.title_match === 'Autonomy',
    'heartbeat REJECTS a "[...]" worker sentinel, keeps the last good label (got "' + st.conductor.title_match + '")')

  // A multi-line brief and a raw dispatch header are also rejected.
  await coord.conductor_heartbeat({ title_match: '[infra health pulse]\n<dispatched role="worker" .../>' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.title_match === 'Autonomy', 'heartbeat REJECTS a multi-line "[...]\\n<dispatched" brief')

  // register_conductor with a "[...]" param keeps the prior good label rather than poisoning.
  const reg2 = await coord.register_conductor({
    tab_id: 'conductor', ide: 'stable', ide_bridge_port: 7457, claude_port: 45955, ide_pid: 87491,
    title_match: '[social engagement engine]',
  })
  assert(reg2.conductor.title_match === 'Autonomy',
    'register_conductor REJECTS a "[...]" title_match, keeps the prior good label (got "' + reg2.conductor.title_match + '")')

  // A legitimate human label still updates the slot (the belt has teeth for real labels).
  await coord.conductor_heartbeat({ title_match: 'DayCrew' })
  st = await coord.get_conductor_state({})
  assert(st.conductor.title_match === 'DayCrew', 'heartbeat still accepts a new legitimate human label')

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  if (fails === 0) { console.log('ALL TESTS PASSED'); process.exit(0) } else { console.log(fails + ' TEST(S) FAILED'); process.exit(1) }
})()
