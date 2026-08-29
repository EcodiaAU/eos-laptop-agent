'use strict'

// Regression test for the SIBLING half of the recurring-cron worker-tab leak
// (2026-08-29). Twin of coord-stable-tab-id-close.test.js.
//
// THE DEFECT. f45fed6 taught coord.close_my_tab and coord.kill_worker the IDE
// bridge's stable per-tab id, but cowork.cleanup_orphan_workers was left on the
// old ladder. That sweep is the ONLY recurring path that closes a tab for a
// worker which never called close_my_tab, and it is wired live: scheduler.js
// runs it every CLEANUP_ORPHAN_INTERVAL_MS (7 min) inside au.ecodia.laptop-agent.
// Measured on the live agent log before this fix, every 7 minutes, for hours:
//     [scheduler] cleanup_orphan_workers: closed=0 of 76 candidates (leaked=76)
// The dominant corpse population is exactly the one that can never self-close:
// 77 of 111 terminated rows carry terminated_reason=stale_heartbeat, meaning the
// worker was killed or usage-capped mid-run so no close path ever ran.
//
// WHY THE OLD LADDER CANNOT WIN. A recurring cron re-fires ONE os_scheduled_tasks
// row with a byte-identical brief, so fire N and fire N+1 carry the same
// sentinel_prefix and the same autotitle_fingerprint, and Claude Code summarises
// both to the same tab title. Every one of the ladder's handles is derived from
// that brief, so every one collides:
//   Pass 1 tabIndex   - volatile, and its confirmation is the colliding label.
//   Pass 2 sentinel   - claimed-set is keyed on the LABEL, so two corpses sharing
//                       a label produce one key and the second is locked out.
//   Pass 2.5 autotitle- matched then REFUSED unconditionally by tab-close-guard
//                       belt 3 on every sweep path (2026-07-21). Dead weight.
// The tab count therefore climbs without bound, and Tate 2026-08-16: "If you go
// oom the vscode clause code tabs crash and it kills your scheduled tasks
// ability to spawn." That is the P1.
//
// THE FIX UNDER TEST. Rows carrying tab_handle.tabId resolve through coord's
// _resolveStableIdCloseTarget / _closeStableIdTarget, on the exact id, with NO
// fallthrough to the colliding ladder when the id is stored but not live. Rows
// with no stored id keep the legacy ladder unchanged.
//
// WHY THE CLOSE STUB SPLICES. A close shifts every later tab's index. If this
// stub kept a static array, a stale-single-snapshot implementation would pass the
// two-corpse assertion and the test could not fail on the very bug it exists to
// catch. Splicing means only a per-orphan re-probe stays green. Doctrine:
// a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Every refusal assertion is PAIRED with a positive control on the same fixture
// differing only in the variable under test.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/cowork-orphan-sweep-stable-id.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-orphan-stableid-'))
process.env.COORD_ROOT = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'conductors'), { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'workers'), { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'chat-tabs'), { recursive: true })
fs.writeFileSync(
  path.join(tmpRoot, 'conductors', 'current.json'),
  JSON.stringify({ tab_id: 'conductor', ide_bridge_port: 65535, title_match: 'CONDUCTOR OWN CHAT' })
)

const ide = require('./ide')
const cowork = require('./cowork')

const CC = 'mainThreadWebview-claudeVSCodePanel'
const WORKERS_DIR = path.join(tmpRoot, 'workers')

// The cron shape: one row, several fires, byte-identical brief.
const SENTINEL = '[68d5 pattern binding ttl sweep daily]'
const AUTOTITLE = 'Pattern binding TTL sweep'

let LIVE_TABS = []
const closeCalls = []

ide.tabs = async () => ({
  groups: [{
    viewColumn: 1,
    isActive: true,
    tabs: LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i, viewColumn: 1 }, t)),
  }],
})

// Mirrors the real bridge: exactLabel is a race guard against the slot moving,
// and a successful close REMOVES the tab so every later index shifts down.
ide.tabs_close = async (req) => {
  closeCalls.push(req)
  const i = typeof req.tabIndex === 'number' ? req.tabIndex : -1
  const at = LIVE_TABS[i]
  if (!at) return { closed: 0, matched: 0, refused: 'no_tab_at_index' }
  if (req.exactLabel && at.label !== req.exactLabel) {
    return { closed: 0, matched: 0, refused: 'exactLabel_mismatch' }
  }
  LIVE_TABS.splice(i, 1)
  return { closed: 1, matched: 1 }
}

let fails = 0
function ok(name, cond, extra) {
  if (cond) { console.log('  PASS: ' + name) }
  else { console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); fails++ }
}

function writeCorpse(tab_id, handleExtra) {
  const row = {
    tab_id: tab_id,
    task_id: 'ttl-sweep-row',
    terminated_at: new Date(Date.now() - 60_000).toISOString(),
    terminated_reason: 'stale_heartbeat',
    tab_handle: Object.assign({
      sentinel_prefix: SENTINEL,
      viewColumn: 1,
      viewType: CC,
      label_at_spawn: 'Claude Code',
      tabIndex: 0,
    }, handleExtra || {}),
  }
  fs.writeFileSync(path.join(WORKERS_DIR, tab_id + '.json'), JSON.stringify(row, null, 2))
  return row
}

function readRow(tab_id) {
  return JSON.parse(fs.readFileSync(path.join(WORKERS_DIR, tab_id + '.json'), 'utf8'))
}

function reset() {
  for (const f of fs.readdirSync(WORKERS_DIR)) fs.unlinkSync(path.join(WORKERS_DIR, f))
  closeCalls.length = 0
  // 2026-08-29 lane W1-verify. coord.loadWorkerRegistry reads its in-memory
  // workers Map BEFORE disk (the same-process hot path), and this reset only
  // ever deleted files. Any case that makes coord WRITE the registry therefore
  // leaked a stale row into the next case, which read as a fresh fixture
  // resolving {none}. Latent since the map existed; it first bit when the close
  // path started re-capturing. Clear both halves or the controls below are
  // measuring the previous case.
  try { require('./coord')._workersMap().clear() } catch (e) {}
}

function resultFor(res, tab_id) {
  return (res.results || []).find((r) => r.tab_id === tab_id) || null
}

async function main() {
  console.log('cowork.cleanup_orphan_workers stable-tab-id close')

  // ---------------------------------------------------------------------
  // 1. THE DEFECT ITSELF. Two corpses of the SAME cron row, same sentinel,
  //    same autotitle, distinct stable ids, both live. Both must close, each
  //    to its OWN id. The old ladder closes at most one (label-keyed claim set).
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [
    { tabId: 'ttab_fire1', label: AUTOTITLE },
    { tabId: 'ttab_fire2', label: AUTOTITLE },
    { tabId: 'ttab_live', label: 'Tate own chat about ecodia site' },
  ]
  writeCorpse('tab_fire_1', { tabId: 'ttab_fire1' })
  writeCorpse('tab_fire_2', { tabId: 'ttab_fire2' })

  let res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('two same-sentinel cron corpses BOTH close', res.closed === 2,
     'closed=' + res.closed + ' results=' + JSON.stringify(res.results))
  ok('fire 1 closed on its own stable id',
     (resultFor(res, 'tab_fire_1') || {}).strategy === 'stable_tab_id:ttab_fire1',
     JSON.stringify(resultFor(res, 'tab_fire_1')))
  ok('fire 2 closed on its own stable id',
     (resultFor(res, 'tab_fire_2') || {}).strategy === 'stable_tab_id:ttab_fire2',
     JSON.stringify(resultFor(res, 'tab_fire_2')))
  ok('both corpse tabs are gone from the live listing',
     !LIVE_TABS.some((t) => t.tabId === 'ttab_fire1' || t.tabId === 'ttab_fire2'),
     JSON.stringify(LIVE_TABS))
  // The whole point of a stable id: the bystander with a human title survives.
  ok('the unrelated human chat survives', LIVE_TABS.some((t) => t.tabId === 'ttab_live'))
  ok('registry row records the stable-id strategy',
     /stable_tab_id/.test(readRow('tab_fire_1').closed_tab_strategy || ''),
     readRow('tab_fire_1').closed_tab_strategy)
  ok('registry row marked closed_tab_ok', readRow('tab_fire_2').closed_tab_ok === true)

  // ---------------------------------------------------------------------
  // 2. THE CONTROL THAT MAKES 1 MEAN SOMETHING. A stored id that is NOT live,
  //    while a same-sentinel tab IS live and the legacy ladder WOULD have
  //    matched it. Must refuse, not fall through onto the stranger.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [
    { tabId: 'ttab_someone_else', label: AUTOTITLE },
  ]
  writeCorpse('tab_gone', { tabId: 'ttab_never_live' })

  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  const gone = resultFor(res, 'tab_gone')
  ok('stored-but-not-live id refuses instead of closing', res.closed === 0,
     'closed=' + res.closed + ' ' + JSON.stringify(res.results))
  // 2026-08-29 lane W1-verify: the sweep now RE-CAPTURES a proven-dead id before
  // refusing on it, so the terminal reason is either the id still being not-live or
  // the re-capture having failed to replace it. Both are stable-id reasons and both
  // are terminal. What must never appear here is a LADDER outcome, because the
  // ladder would resolve this corpse's sentinel onto the live stranger below.
  ok('refusal names a stable-id reason, not a ladder miss',
     !!gone && gone.action === 'leak'
       && /stable_id_not_live|stable_id_dropped_not_recaptured/.test(String(gone.reason)),
     JSON.stringify(gone))
  ok('NO close was attempted at the bridge at all', closeCalls.length === 0,
     JSON.stringify(closeCalls))
  ok('the same-sentinel stranger tab is untouched',
     LIVE_TABS.length === 1 && LIVE_TABS[0].tabId === 'ttab_someone_else')
  ok('a refused row gains no closed_tab_* fields',
     !Object.keys(readRow('tab_gone')).some((k) => k.startsWith('closed_tab_')),
     JSON.stringify(Object.keys(readRow('tab_gone'))))

  // ---------------------------------------------------------------------
  // 2b. POSITIVE CONTROL for 2, differing ONLY in whether the id is live.
  //     Same fixture, same stranger present. Proves the refusal in 2 came from
  //     the id being dead, not from the sweep being inert on this shape.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [
    { tabId: 'ttab_someone_else', label: AUTOTITLE },
    { tabId: 'ttab_never_live', label: AUTOTITLE },
  ]
  writeCorpse('tab_gone', { tabId: 'ttab_never_live' })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('CONTROL: the identical row closes once its id IS live', res.closed === 1,
     'closed=' + res.closed + ' ' + JSON.stringify(res.results))
  ok('CONTROL: and it closed the id it stored, not the lookalike',
     !LIVE_TABS.some((t) => t.tabId === 'ttab_never_live') &&
     LIVE_TABS.some((t) => t.tabId === 'ttab_someone_else'),
     JSON.stringify(LIVE_TABS))

  // ---------------------------------------------------------------------
  // 3. LEGACY ROWS ARE UNCHANGED. A pre-cutover corpse carries no stable id,
  //    so it must still take the sentinel ladder. Regression guard: the fix
  //    must not strand the ~69 accreted no-id corpses it cannot identify.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [
    { tabId: 'ttab_legacy', label: SENTINEL + ' extra' },
  ]
  writeCorpse('tab_legacy')  // no tabId
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('a no-id legacy corpse still closes via the sentinel ladder', res.closed === 1,
     'closed=' + res.closed + ' ' + JSON.stringify(res.results))
  ok('and it reports the legacy strategy, not the stable one',
     /sentinel_prefix|tabIndex/.test(String((resultFor(res, 'tab_legacy') || {}).strategy)),
     JSON.stringify(resultFor(res, 'tab_legacy')))

  // ---------------------------------------------------------------------
  // 4. THE SAFETY BELTS STILL BIND ON THE NEW PATH. A stable id is a positive
  //    identity, but it must not become a licence to close the focused tab or
  //    the registered conductor. Both are paired with the same-shape control
  //    above (test 1), which closed fine.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [{ tabId: 'ttab_focused', label: AUTOTITLE, active: true }]
  writeCorpse('tab_focused', { tabId: 'ttab_focused' })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('belt 1 holds: an ACTIVE tab is refused even on a stable id',
     res.closed === 0 && /active_tab_protected/.test(String((resultFor(res, 'tab_focused') || {}).reason)),
     JSON.stringify(res.results))
  ok('belt 1: the focused tab survives', LIVE_TABS.length === 1)

  reset()
  LIVE_TABS = [{ tabId: 'ttab_conductor', label: 'CONDUCTOR OWN CHAT' }]
  writeCorpse('tab_conductor_lookalike', { tabId: 'ttab_conductor' })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('belt 2 holds: the conductor label is refused even on a stable id',
     res.closed === 0 && /conductor_label_protected/.test(String((resultFor(res, 'tab_conductor_lookalike') || {}).reason)),
     JSON.stringify(res.results))
  ok('belt 2: the conductor tab survives', LIVE_TABS.length === 1)

  // ---------------------------------------------------------------------
  // 5. THE STALE-SNAPSHOT TRAP. Three corpses, all closing in one pass. Any
  //    implementation resolving them against ONE up-front probe sends indices
  //    that have already shifted, the bridge exactLabel guard refuses, and
  //    corpses 2 and 3 leak. Only a per-orphan re-probe closes all three.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [
    { tabId: 'ttab_a', label: AUTOTITLE },
    { tabId: 'ttab_b', label: AUTOTITLE },
    { tabId: 'ttab_c', label: AUTOTITLE },
    { tabId: 'ttab_keep', label: 'Tate own chat' },
  ]
  writeCorpse('tab_a', { tabId: 'ttab_a' })
  writeCorpse('tab_b', { tabId: 'ttab_b' })
  writeCorpse('tab_c', { tabId: 'ttab_c' })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('all three corpses close despite indices shifting under each close',
     res.closed === 3, 'closed=' + res.closed + ' ' + JSON.stringify(res.results))
  ok('no close was refused for a moved slot',
     !(res.results || []).some((r) => /exactLabel_mismatch/.test(JSON.stringify(r.raw || r.refused || ''))),
     JSON.stringify(res.results))
  ok('only the human chat is left', LIVE_TABS.length === 1 && LIVE_TABS[0].tabId === 'ttab_keep',
     JSON.stringify(LIVE_TABS))

  // ---------------------------------------------------------------------
  // 6. DRY RUN NEVER CLOSES. The sweep is called with dry_run by operators
  //    inspecting the backlog; a stable id must not bypass that.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [{ tabId: 'ttab_dry', label: AUTOTITLE }]
  writeCorpse('tab_dry', { tabId: 'ttab_dry' })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7, dry_run: true })
  ok('dry_run reports would_close and closes nothing',
     res.closed === 0 && (resultFor(res, 'tab_dry') || {}).action === 'would_close' && LIVE_TABS.length === 1,
     JSON.stringify(res.results))

  console.log('')
  if (fails) { console.log(fails + ' FAILED'); process.exit(1) }
  console.log('all assertions passed')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
