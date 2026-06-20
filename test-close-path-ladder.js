// Close-path test harness for the 2026-05-29 ultracode audit hardening.
//
// Covers H8 (zero test coverage of close/kill match ladder) by asserting:
//   - kill_worker CAN load a stored handle via coord.loadWorkerRegistry
//     (refutes audit C1 once fixed)
//   - Tier (a) tabIndex REQUIRES label/sentinel confirmation
//     (refutes audit C2 once fixed)
//   - Tier (b) sentinel_prefix matches when tier (a) declines
//   - Tier (c) exact_label matches when (a) and (b) both decline
//   - Refuse-and-leak fires when NO tier matches (never wrong-close)
//
// Runs against the real coord+cowork modules with a stubbed ide module.

const path = require('path')
const fs = require('fs')
const os = require('os')

// Sandbox COORD_ROOT to a temp dir so we don't pollute production registry.
const TMP_COORD_ROOT = path.join(os.tmpdir(), 'eos-test-coord-' + Date.now())
process.env.COORD_ROOT = TMP_COORD_ROOT
process.env.NODE_ENV = 'test'

const coord = require('./tools/coord')
const cowork = require('./tools/cowork')

const TAB_ID_A = 'tab_test_a_abc'
const TAB_ID_B = 'tab_test_b_def'
const TAB_ID_C = 'tab_test_c_ghi'
const TAB_ID_NOMATCH = 'tab_test_nomatch_xyz'

// Seed registry rows on disk (cowork.kill_worker reads via
// coord.loadWorkerRegistry which checks Map first then disk).
function seedWorker(tab_id, tab_handle) {
  const row = {
    tab_id: tab_id,
    tab_credential: 'cred-' + tab_id,
    task_id: 'task-' + tab_id,
    parent_conductor_tab_id: 'conductor',
    account_active_when_spawned: 'test@ecodia',
    registered_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    status: 'test',
    in_critical_section: false,
    tab_handle: tab_handle,
    tab_handle_set_at: new Date().toISOString(),
  }
  fs.mkdirSync(path.join(TMP_COORD_ROOT, 'workers'), { recursive: true })
  fs.mkdirSync(path.join(TMP_COORD_ROOT, 'state'), { recursive: true })
  fs.writeFileSync(path.join(TMP_COORD_ROOT, 'workers', tab_id + '.json'), JSON.stringify(row, null, 2))
}

// Stub ide module - cowork.kill_worker requires('./ide') so we patch the cache.
let mockTabsResponse = { groups: [] }
const closeCalls = []
const ideStub = {
  tabs: async () => mockTabsResponse,
  tabs_close: async (params) => {
    closeCalls.push(params)
    // Simulate the bridge actually closing one tab if a candidate is found.
    return { closed: 1, matched: 1 }
  },
}
require.cache[require.resolve('./tools/ide')] = { exports: ideStub }

const CC = 'mainThreadWebview-claudeVSCodePanel'
const FILE = 'someFileViewType'

const results = []
function assertEq(label, expected, actual) {
  const pass = expected === actual
  results.push({ label, pass, expected, actual })
  return pass
}
function assertTruthy(label, value) {
  const pass = !!value
  results.push({ label, pass, expected: 'truthy', actual: value })
  return pass
}

async function run() {
  // -----------------------------------------------------------------------
  // T1: C1 refutation - kill_worker LOADS the stored handle from disk
  // -----------------------------------------------------------------------
  seedWorker(TAB_ID_A, {
    sentinel_prefix: '[EOS-W-aaaaaaaa]',
    viewColumn: 1,
    viewType: CC,
    label_at_spawn: '[EOS-W-aaaaaaaa] hello',
    tabIndex: 0,
  })
  // ide.tabs returns vc1 with tab[0] = the matching CC chat
  mockTabsResponse = {
    groups: [{
      viewColumn: 1, isActive: true,
      tabs: [{ label: '[EOS-W-aaaaaaaa] hello', active: true, viewType: CC, index: 0 }],
    }],
  }
  closeCalls.length = 0
  let r = await cowork.kill_worker({ tab_id: TAB_ID_A })
  assertEq('T1 C1: kill_worker found tab_handle on disk', true, r.closed)
  assertEq('T1 C1: close request used tabIndex strategy', 0, closeCalls[0] && closeCalls[0].tabIndex)
  assertEq('T1 C1: close request preserved exactLabel sanity', '[EOS-W-aaaaaaaa] hello', closeCalls[0] && closeCalls[0].exactLabel)

  // -----------------------------------------------------------------------
  // T2: C2 refutation - tabIndex tier REFUSES on identity mismatch,
  //                     falls through to sentinel/label tiers
  // -----------------------------------------------------------------------
  seedWorker(TAB_ID_B, {
    sentinel_prefix: '[EOS-W-bbbbbbbb]',
    viewColumn: 1,
    viewType: CC,
    label_at_spawn: '[EOS-W-bbbbbbbb] bee',
    tabIndex: 2,  // worker was at index 2 at spawn time
  })
  // Now the user inserted a tab at index 0, so worker drifted to index 3.
  // Tab AT stored index 2 is a DIFFERENT live worker (worker C).
  mockTabsResponse = {
    groups: [{
      viewColumn: 1, isActive: true,
      tabs: [
        { label: 'Tate manual chat', active: false, viewType: CC, index: 0 },  // inserted
        { label: 'Other work', active: false, viewType: CC, index: 1 },
        { label: '[EOS-W-zzzzzzzz] zee', active: false, viewType: CC, index: 2 },  // DIFFERENT worker
        { label: '[EOS-W-bbbbbbbb] bee', active: false, viewType: CC, index: 3 },  // OUR worker (drifted)
      ],
    }],
  }
  closeCalls.length = 0
  r = await cowork.kill_worker({ tab_id: TAB_ID_B })
  assertEq('T2 C2: close succeeded', true, r.closed)
  // tabIndex tier MUST have refused (different label at index 2). Sentinel
  // tier found the real worker at index 3. close_request should NOT carry
  // tabIndex (we fell through to sentinel).
  assertEq('T2 C2: close request did NOT use stale tabIndex', undefined, closeCalls[0] && closeCalls[0].tabIndex)
  assertEq('T2 C2: close request targeted exact CORRECT label', '[EOS-W-bbbbbbbb] bee', closeCalls[0] && closeCalls[0].exactLabel)

  // -----------------------------------------------------------------------
  // T3: Refuse-and-leak when NO tier matches
  // -----------------------------------------------------------------------
  seedWorker(TAB_ID_NOMATCH, {
    sentinel_prefix: '[EOS-W-cccccccc]',
    viewColumn: 1,
    viewType: CC,
    label_at_spawn: '[EOS-W-cccccccc] orig',
    tabIndex: 1,
  })
  // The chat auto-retitled AND drag-reordered. Sentinel prefix is gone, no
  // matching label, tabIndex points at unrelated tab.
  mockTabsResponse = {
    groups: [{
      viewColumn: 1, isActive: true,
      tabs: [
        { label: 'Tate active chat', active: true, viewType: CC, index: 0 },
        { label: 'Unrelated chat', active: false, viewType: CC, index: 1 },
        { label: 'Some autotitle summary', active: false, viewType: CC, index: 2 },
      ],
    }],
  }
  closeCalls.length = 0
  r = await cowork.kill_worker({ tab_id: TAB_ID_NOMATCH })
  assertEq('T3 refuse-and-leak: kill_worker refused', false, r.closed)
  assertTruthy('T3 refuse-and-leak: refused reason present', r.refused)
  assertEq('T3 refuse-and-leak: NO close request issued (leak-not-murder)', 0, closeCalls.length)

  // -----------------------------------------------------------------------
  // T4: cleanup_orphan_workers READS the env-resolved COORD_ROOT registry
  //     and CLOSES a matchable orphan.
  //
  // 2026-06-20 regression. cowork.js hardcoded COORD_ROOT to the dead Corazon
  // Windows path with no env override, so on the Mac canonical host
  // cleanup_orphan_workers scanned an empty literal "D:\\..." directory and
  // returned candidates=0 / closed=0 every pass while the real registry at
  // ~/.ecodiaos/coordination/workers (the path coord.js + mac-dispatcher.js
  // resolve from env) accumulated 600+ orphans. This test seeds a terminated,
  // not-yet-closed orphan into the env-pointed COORD_ROOT registry and proves
  // the sweep (a) SEES it as a candidate and (b) actually closes it. Before
  // the fix this asserts candidates=0 (function blind to the registry).
  // -----------------------------------------------------------------------
  const ORPHAN_TAB = 'tab_orphan_sweep_t4'
  const orphanRow = {
    tab_id: ORPHAN_TAB,
    task_id: 'task-' + ORPHAN_TAB,
    parent_conductor_tab_id: 'conductor',
    registered_at: new Date(Date.now() - 3600_000).toISOString(),
    // terminated (signal_done fired) but close never landed -> orphan tab leak.
    terminated_at: new Date(Date.now() - 1800_000).toISOString(),
    // closed_tab_ok absent -> still a candidate for the sweep.
    status: 'completed',
    tab_handle: {
      sentinel_prefix: '[EOS-W-orphant4]',
      viewColumn: 1,
      viewType: CC,
      label_at_spawn: '[EOS-W-orphant4] leaked worker',
      tabIndex: 0,
    },
  }
  fs.mkdirSync(path.join(TMP_COORD_ROOT, 'workers'), { recursive: true })
  const orphanFile = path.join(TMP_COORD_ROOT, 'workers', ORPHAN_TAB + '.json')
  fs.writeFileSync(orphanFile, JSON.stringify(orphanRow, null, 2))

  // The leaked tab is still present in the IDE under its sentinel label.
  mockTabsResponse = {
    groups: [{
      viewColumn: 1, isActive: true,
      tabs: [{ label: '[EOS-W-orphant4] leaked worker', active: false, viewType: CC, index: 0 }],
    }],
  }
  closeCalls.length = 0
  const sweep = await cowork.cleanup_orphan_workers({ dry_run: false, max_age_days: 7 })
  assertTruthy('T4 orphan-sweep: function saw the env-registry candidate', sweep.candidates >= 1)
  assertEq('T4 orphan-sweep: closed exactly 1 orphan', 1, sweep.closed)
  assertEq('T4 orphan-sweep: leaked count is 0', 0, sweep.leaked)
  assertEq('T4 orphan-sweep: a close request was issued', 1, closeCalls.length)
  // Registry row marked closed so the next sweep skips it (no re-close churn).
  let updated = {}
  try { updated = JSON.parse(fs.readFileSync(orphanFile, 'utf8')) } catch (e) {}
  assertEq('T4 orphan-sweep: registry row stamped closed_tab_ok', true, updated.closed_tab_ok)

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------
  let pass = 0, fail = 0
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL'
    if (r.pass) pass++; else fail++
    console.log(`  ${status}  ${r.label}`)
    if (!r.pass) console.log(`         expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`)
  }
  console.log(`\n${pass} pass, ${fail} fail, ${results.length} total`)
  // Cleanup
  try { fs.rmSync(TMP_COORD_ROOT, { recursive: true, force: true }) } catch (e) {}
  process.exit(fail === 0 ? 0 : 1)
}

run().catch(e => { console.error('test harness crashed:', e); process.exit(2) })
