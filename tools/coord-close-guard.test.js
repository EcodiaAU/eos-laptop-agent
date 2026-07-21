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
// precedence over even a positive strategy.
;(() => {
  const d = guard.evaluateClose('sentinel_prefix:EOS-W-x', { label: 'EOS-W-x work', active: true }, null)
  assert(d.allow === false && d.reason === 'active_tab_protected', 'active tab is refused even on a positive strategy')
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

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  if (fails === 0) { console.log('ALL TESTS PASSED'); process.exit(0) } else { console.log(fails + ' TEST(S) FAILED'); process.exit(1) }
})()
