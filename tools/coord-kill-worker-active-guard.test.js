// Unit test for the 2026-07-21 active-tab close guard in cowork.kill_worker.
//
// kill_worker fires on every worker completion (scheduler.markComplete ->
// completionPass every 5s) and every signal_bound-timeout orphan (dispatchOne).
// Its tier-a..d match (esp. the fuzzy autotitle-fingerprint tier) could resolve
// to the conductor's LIVE tab and close it. The active-tab guard refuses to
// close a tab that is currently focused (the conductor Tate types in, or a live
// worker) - a dead/orphaned worker's tab is never the active tab. This is the
// twin of the guard cleanup_orphan_workers already carries.
// Run: node tools/coord-kill-worker-active-guard.test.js
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-guard-'))
process.env.COORD_ROOT = tmpRoot
process.env.COORD_DISABLE_SWEEP = '1'
const WORKERS_DIR = path.join(tmpRoot, 'workers')
fs.mkdirSync(WORKERS_DIR, { recursive: true })

const CC_VT = 'mainThreadWebview-claudeVSCodePanel'
const SENT = 'EOS-W-worker1'

// Worker registry row with a complete tab_handle that matches by sentinel prefix.
const writeWorker = (tab) => fs.writeFileSync(path.join(WORKERS_DIR, tab + '.json'), JSON.stringify({
  tab_id: tab, terminated_at: new Date().toISOString(),
  tab_handle: { viewType: CC_VT, viewColumn: 1, tabIndex: 0, sentinel_prefix: SENT, label: SENT + ' audit' },
}, null, 2))

// Stub ide.tabs to present exactly one CC tab in column 1 whose label matches the
// sentinel (so kill_worker's sentinel tier resolves foundExact to it), with a
// controllable `active` flag. Stub tabs_close to record whether it fired.
const ide = require('./ide')
let closeCalls = 0
ide.tabs_close = async (req) => { closeCalls++; return { result: { closed: 1, ok: true } } }
const setTabs = (active) => { ide.tabs = async () => ({ groups: [ { viewColumn: 1, tabs: [
  { viewType: CC_VT, viewColumn: 1, index: 0, label: SENT + ' audit', active: active },
] } ] }) }

const cowork = require('./cowork.js')

let fails = 0
const assert = (cond, msg) => { if (cond) { console.log('  PASS: ' + msg) } else { console.log('  FAIL: ' + msg); fails++ } }

;(async () => {
  // Case 1: matched tab is ACTIVE (the conductor / a live worker) -> MUST refuse.
  writeWorker('tab_worker1'); setTabs(true); closeCalls = 0
  const r1 = await cowork.kill_worker({ tab_id: 'tab_worker1' })
  assert(r1.closed === false, 'active-tab match is NOT closed')
  assert(/active_tab_protected/.test(r1.refused || ''), 'refused reason is active_tab_protected (got ' + r1.refused + ')')
  assert(closeCalls === 0, 'ide.tabs_close was NOT invoked for the active tab (got ' + closeCalls + ' calls)')

  // Case 2: same match but the tab is BACKGROUNDED (a real dead orphan) -> closes.
  writeWorker('tab_worker1'); setTabs(false); closeCalls = 0
  const r2 = await cowork.kill_worker({ tab_id: 'tab_worker1' })
  assert(r2.closed === true, 'backgrounded orphan tab IS closed (guard is targeted, not a blanket refuse)')
  assert(closeCalls === 1, 'ide.tabs_close fired exactly once for the dead orphan (got ' + closeCalls + ')')

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  if (fails === 0) { console.log('ALL TESTS PASSED'); process.exit(0) } else { console.log(fails + ' TEST(S) FAILED'); process.exit(1) }
})()
