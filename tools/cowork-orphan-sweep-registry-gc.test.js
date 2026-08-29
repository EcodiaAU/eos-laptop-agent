'use strict'

// Regression test for the lane W1 REGISTRY GC (2026-08-29). Third in the family
// with coord-stable-tab-id-close.test.js and cowork-orphan-sweep-stable-id.test.js.
//
// THE DEFECT. The leak counter was lying. The live agent printed, every 7
// minutes, for hours:
//     [scheduler] cleanup_orphan_workers: closed=0 of 76 candidates (leaked=76)
// which reads as 76 abandoned IDE tabs burning memory toward the OOM that Tate
// named as the P1. It was not that. Measured in ~/.ecodiaos/coordination/workers
// at 2026-08-29T04:00Z: 104 rows, 84 terminated, and ZERO whose stored tabId
// pointed at a tab that still existed, against only 12 live tabs. Every one of
// those 76 was a corpse whose tab was ALREADY GONE. No close path can ever
// succeed on such a row, so Pass 0 refused it correctly on every sweep, forever,
// and the sweep re-scanned and re-counted the same corpses until the 24h
// retention backstop in coord.sweepStaleWorkers finally aged them out.
//
// A row proven dead is not a leak, it is garbage. This suite pins the gate that
// decides "proven dead" and the unlink that follows it.
//
// WHY A GC AT ALL, given the 24h backstop already drains the pile: the backstop
// is an AGE rule, so it cannot distinguish a corpse from a ghost, and until it
// fires the operator-facing counter conflates the two. The value here is the
// classification; the unlink is what stops the same corpse being re-counted.
//
// EVERY REFUSAL ASSERTION IS PAIRED WITH A POSITIVE CONTROL on the same fixture
// differing only in the variable under test, because a gate that refuses
// everything passes every refusal assertion while doing nothing.
// Doctrine: a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/cowork-orphan-sweep-registry-gc.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-registry-gc-'))
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
const coord = require('./coord')

const CC = 'mainThreadWebview-claudeVSCodePanel'
const WORKERS_DIR = path.join(tmpRoot, 'workers')
const SENTINEL = '[2306 coord tab close lane W1 registry g]'

let LIVE_TABS = []
let TABS_THROWS = false

ide.tabs = async () => {
  if (TABS_THROWS) throw new Error('bridge unreachable')
  return {
    groups: [{
      viewColumn: 1,
      isActive: true,
      tabs: LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i, viewColumn: 1 }, t)),
    }],
  }
}
ide.tabs_close = async (req) => {
  const i = typeof req.tabIndex === 'number' ? req.tabIndex : -1
  const at = LIVE_TABS[i]
  if (!at) return { closed: 0, matched: 0, refused: 'no_tab_at_index' }
  if (req.exactLabel && at.label !== req.exactLabel) return { closed: 0, matched: 0, refused: 'exactLabel_mismatch' }
  LIVE_TABS.splice(i, 1)
  return { closed: 1, matched: 1 }
}

let fails = 0
function ok(name, cond, extra) {
  if (cond) { console.log('  PASS: ' + name) }
  else { console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); fails++ }
}

function writeRow(tab_id, over) {
  const row = Object.assign({
    tab_id: tab_id,
    task_id: 'registry-gc-row',
    terminated_at: new Date(Date.now() - 60_000).toISOString(),
    terminated_reason: 'stale_heartbeat',
    // Older than GC_MIN_QUIET_MS (120min). The GC's second liveness signal
    // refuses a non-cleanly-terminated row that has heartbeated recently,
    // because the stale-heartbeat mark is a false positive on a worker mid
    // Bash-only stretch. Case 9 below pins that guard on both sides.
    last_heartbeat_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    registered_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
    tab_handle: {
      sentinel_prefix: SENTINEL,
      viewColumn: 1,
      viewType: CC,
      label_at_spawn: 'Claude Code',
      tabIndex: 0,
      tabId: 'ttab_dead_' + tab_id,
    },
  }, over || {})
  fs.writeFileSync(path.join(WORKERS_DIR, tab_id + '.json'), JSON.stringify(row, null, 2))
  return row
}

const exists = (tab_id) => fs.existsSync(path.join(WORKERS_DIR, tab_id + '.json'))
const readRow = (tab_id) => JSON.parse(fs.readFileSync(path.join(WORKERS_DIR, tab_id + '.json'), 'utf8'))
function resultFor(res, tab_id) { return (res.results || []).find((r) => r.tab_id === tab_id) || null }

function reset() {
  for (const f of fs.readdirSync(WORKERS_DIR)) fs.unlinkSync(path.join(WORKERS_DIR, f))
  TABS_THROWS = false
  // Both halves: coord reads its in-memory Map before disk on the same-process
  // hot path, so deleting files alone leaks a stale row into the next case.
  try { coord._workersMap().clear() } catch (e) {}
}

async function main() {
  console.log('cowork.cleanup_orphan_workers registry GC')

  // ---------------------------------------------------------------------
  // 1. THE FIX. A terminated row whose stored id is absent from a SUCCESSFUL,
  //    NON-EMPTY listing is proven dead. One pass is one signal, so pass 1 only
  //    banks a confirmation and the row SURVIVES. Pass 2 is an independent
  //    listing agreeing, and only then is the row unlinked.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [{ tabId: 'ttab_someone_else', label: 'Tate own chat about ecodia site' }]
  writeRow('tab_corpse')

  let res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  let r1 = resultFor(res, 'tab_corpse')
  ok('pass 1 classifies a proven-dead row as gone_pending, NOT leak',
     r1 && r1.action === 'gone_pending', JSON.stringify(r1))
  ok('pass 1 does NOT unlink (one signal is never enough)', exists('tab_corpse'))
  ok('pass 1 banks confirmation 1 on disk',
     exists('tab_corpse') && readRow('tab_corpse').tab_gone_confirmations === 1)
  ok('pass 1 counts it out of leaked', res.leaked === 0, 'leaked=' + res.leaked)
  ok('pass 1 reports gone_pending in the return shape', res.gone_pending === 1)

  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  let r2 = resultFor(res, 'tab_corpse')
  ok('pass 2 GCs the row after a second independent listing agrees',
     r2 && r2.action === 'gone', JSON.stringify(r2))
  ok('pass 2 UNLINKS the registry file', !exists('tab_corpse'))
  ok('pass 2 reports gone in the return shape', res.gone === 1)

  // ---------------------------------------------------------------------
  // 2. FAIL-SAFE, the inversion that turns a janitor into a shredder.
  //    An EMPTY listing proves no absence. Neither does a FAILED probe.
  //    Positive control: case 1 above GC'd on the identical fixture, the only
  //    difference being that its listing was successful and non-empty.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = []
  writeRow('tab_empty_listing')
  await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('an EMPTY listing GCs nothing, even across two passes', exists('tab_empty_listing'))
  ok('an empty listing banks no confirmation',
     !readRow('tab_empty_listing').tab_gone_confirmations)
  ok('an empty listing reports gone=0', (res.gone || 0) === 0)

  reset()
  writeRow('tab_probe_threw')
  TABS_THROWS = true
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('a FAILED ide.tabs probe aborts the sweep and GCs nothing',
     exists('tab_probe_threw') && res.ok === false, JSON.stringify(res && res.error))

  // ---------------------------------------------------------------------
  // 3. THE SURVIVOR. An ACTIVE worker (terminated_at null) is never a candidate
  //    and is never GC'd. This is the row shape of the worker running this very
  //    dispatch. Deleting one strands a LIVE tab with no close path at all.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [{ tabId: 'ttab_someone_else', label: 'unrelated' }]
  writeRow('tab_live_worker', { terminated_at: null, terminated_reason: null,
                                last_heartbeat_at: new Date().toISOString() })
  writeRow('tab_corpse2')
  await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('a LIVE worker row survives both passes', exists('tab_live_worker'))
  ok('the live row is never even a candidate', !resultFor(res, 'tab_live_worker'))
  ok('POSITIVE CONTROL: the corpse beside it WAS collected', !exists('tab_corpse2'))

  // ---------------------------------------------------------------------
  // 4. A row whose stored id IS live is not dead. It must take the close path,
  //    never the GC path.
  // ---------------------------------------------------------------------
  reset()
  writeRow('tab_still_live')
  LIVE_TABS = [{ tabId: 'ttab_dead_tab_still_live', label: 'Coord close' }]
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  const r4 = resultFor(res, 'tab_still_live')
  ok('a row whose stored id is LIVE is closed, not collected',
     r4 && r4.action !== 'gone' && r4.action !== 'gone_pending', JSON.stringify(r4))
  ok('a live-id row keeps its registry file', exists('tab_still_live'))

  // ---------------------------------------------------------------------
  // 5. THE INVERTED-PROOF TRAP. _captureStableTabId runs its own fresh probe,
  //    so an id it newly captured can legitimately be absent from liveIdSet,
  //    which was snapshotted BEFORE the re-capture. Without the
  //    !recaptureReplaced conjunct, a SUCCESSFUL re-capture reads as proof of
  //    death: exactly backwards. Here the stored id is dead but the sentinel is
  //    live, so re-capture finds a real tab.
  // ---------------------------------------------------------------------
  //
  //    The real _captureStableTabId probes the IDE bridge over HTTP on the
  //    conductor's ide_bridge_port, which no unit harness can serve, so it
  //    always fails-safe here and the conjunct would never be exercised. Stub
  //    the module property (cowork resolves it at call time) so the REPLACEMENT
  //    is what is under test rather than the transport.
  reset()
  writeRow('tab_recaptured')
  //    The replacement id must be ABSENT from the up-front snapshot, because
  //    that absence is the entire point: liveIdSet was taken BEFORE the
  //    re-capture, so a genuinely fresh id cannot be in it. Handing the stub an
  //    id that IS in the snapshot makes the case pass with or without the
  //    conjunct, which is a gate that cannot fail. Verified by reverting the
  //    conjunct: this assertion goes red, and it did not before this change.
  LIVE_TABS = [{ tabId: 'ttab_someone_else', label: 'unrelated' }]
  const realCapture = coord._captureStableTabId
  coord._captureStableTabId = async (tab_id) => {
    const f = path.join(WORKERS_DIR, tab_id + '.json')
    const row = JSON.parse(fs.readFileSync(f, 'utf8'))
    row.tab_handle.tabId = 'ttab_freshly_minted'    // real tab; the snapshot predates it
    row.tab_handle.tabId_captured_via = 'test_recapture'
    fs.writeFileSync(f, JSON.stringify(row, null, 2))
    return { ok: true, tabId: 'ttab_freshly_minted' }
  }
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  coord._captureStableTabId = realCapture
  const r5 = resultFor(res, 'tab_recaptured')
  ok('a row whose id was RE-CAPTURED to a live tab is not collected',
     r5 && r5.action !== 'gone' && r5.action !== 'gone_pending', JSON.stringify(r5))
  ok('a re-captured row keeps its registry file', exists('tab_recaptured'))

  //    CONTROL on the same fixture: re-capture that finds NOTHING leaves the
  //    dead id in place, and the row IS collected. Only the stub differs.
  reset()
  writeRow('tab_recapture_failed')
  LIVE_TABS = [{ tabId: 'ttab_someone_else', label: 'unrelated' }]
  coord._captureStableTabId = async () => ({ ok: false, reason: 'not_found' })
  await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  coord._captureStableTabId = realCapture
  ok('CONTROL: a FAILED re-capture leaves the row collectable',
     !exists('tab_recapture_failed'), JSON.stringify(resultFor(res, 'tab_recapture_failed')))

  // ---------------------------------------------------------------------
  // 6. A row that never held a stable id is NOT provably dead: absence of a
  //    handle is not evidence about the tab. Those stay on the 24h backstop.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [{ tabId: 'ttab_someone_else', label: 'unrelated' }]
  writeRow('tab_no_id', { tab_handle: { sentinel_prefix: SENTINEL, viewColumn: 1,
                                        viewType: CC, label_at_spawn: 'Claude Code', tabIndex: 0 } })
  await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7 })
  ok('a row with NO stored id is never collected', exists('tab_no_id'))
  ok('a no-id row is still reported as a leak, not silently dropped',
     (res.leaked || 0) >= 1, JSON.stringify(res.results))

  // ---------------------------------------------------------------------
  // 7. dry_run enumerates and mutates NOTHING. The skill's rung 1.
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [{ tabId: 'ttab_someone_else', label: 'unrelated' }]
  writeRow('tab_dry')
  res = await cowork.cleanup_orphan_workers({ max_age_days: 7, dry_run: true })
  const r7 = resultFor(res, 'tab_dry')
  // conf 1 of 2, so the honest answer is would_gc_pending: this pass alone
  // would NOT destroy it. A dry run that said would_gc here would overstate the
  // blast radius by every row still banking its first confirmation.
  ok('dry_run reports would_gc_pending at confirmation 1',
     r7 && r7.action === 'would_gc_pending', JSON.stringify(r7))
  ok('dry_run unlinks nothing', exists('tab_dry'))
  ok('dry_run banks no confirmation', !readRow('tab_dry').tab_gone_confirmations)

  // ---------------------------------------------------------------------
  // 8. THE HELPER'S OWN GUARDS. The caller proves death, but _gcWorkerRow
  //    re-reads from DISK and independently refuses what it cannot confirm.
  //    terminated_at is re-read because the caller's value was read before
  //    several awaits and a worker can bind and heartbeat in that gap.
  // ---------------------------------------------------------------------
  reset()
  writeRow('tab_active_direct', { terminated_at: null })
  let g = coord._gcWorkerRow('tab_active_direct', {})
  ok('_gcWorkerRow REFUSES a row with terminated_at null',
     g && g.ok === false && g.reason === 'not_terminated', JSON.stringify(g))
  ok('_gcWorkerRow left the active file on disk', exists('tab_active_direct'))

  writeRow('tab_term_direct')
  g = coord._gcWorkerRow('tab_term_direct', {})
  ok('POSITIVE CONTROL: _gcWorkerRow collects a genuinely terminated row',
     g && g.ok === true, JSON.stringify(g))
  ok('_gcWorkerRow unlinked the terminated file', !exists('tab_term_direct'))

  writeRow('conductor')
  g = coord._gcWorkerRow('conductor', {})
  ok('_gcWorkerRow REFUSES the registered conductor tab even when terminated',
     g && g.ok === false && g.reason === 'registered_conductor', JSON.stringify(g))
  ok('the conductor row survives', exists('conductor'))

  g = coord._gcWorkerRow('tab_does_not_exist', {})
  ok('_gcWorkerRow refuses an unreadable row rather than throwing',
     g && g.ok === false && /row_unreadable/.test(g.reason), JSON.stringify(g))

  reset()
  writeRow('tab_dry_direct')
  g = coord._gcWorkerRow('tab_dry_direct', { dry_run: true })
  ok('_gcWorkerRow honours dry_run', g && g.ok === true && g.dry_run === true && exists('tab_dry_direct'))

  // ---------------------------------------------------------------------
  // 9. THE SECOND LIVENESS SIGNAL. "Tab is gone" is ONE signal. terminated_at is
  //    not the second, because the stale-heartbeat sweep sets it on a worker
  //    that may still be RUNNING (built-in Bash/Read/Grep bypass the heartbeat
  //    middleware entirely, which is why the stale threshold is 60min). Its row
  //    is its registry identity, so deleting it makes the live worker's own
  //    signal_done fail unknown_worker. Union required: tab gone AND (clean
  //    exit OR long silence).
  // ---------------------------------------------------------------------
  reset()
  LIVE_TABS = [{ tabId: 'ttab_someone_else', label: 'unrelated' }]
  writeRow('tab_stale_but_warm', {
    terminated_reason: 'stale_heartbeat',
    last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),  // 10 min: recent
  })
  let g9 = coord._gcWorkerRow('tab_stale_but_warm', {})
  ok('a stale-marked row that heartbeated RECENTLY is refused (may still be live)',
     g9 && g9.ok === false && g9.reason === 'not_quiet_enough', JSON.stringify(g9))
  ok('the possibly-live worker keeps its registry identity', exists('tab_stale_but_warm'))

  //    CONTROL A: identical row, only the heartbeat age differs.
  writeRow('tab_stale_and_quiet', {
    terminated_reason: 'stale_heartbeat',
    last_heartbeat_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  })
  g9 = coord._gcWorkerRow('tab_stale_and_quiet', {})
  ok('CONTROL: the same row, long silent, IS collected', g9 && g9.ok === true, JSON.stringify(g9))

  //    CONTROL B: a worker that terminated by its OWN clean protocol has no
  //    liveness doubt at all, so the quiet period does not apply to it.
  writeRow('tab_clean_exit_warm', {
    terminated_reason: 'signal_done',
    last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  })
  g9 = coord._gcWorkerRow('tab_clean_exit_warm', {})
  ok('CONTROL: a signal_done row is collected regardless of heartbeat age',
     g9 && g9.ok === true, JSON.stringify(g9))

  //    A row with no usable heartbeat timestamp at all fails SAFE.
  writeRow('tab_no_hb', { terminated_reason: 'stale_heartbeat', last_heartbeat_at: null, registered_at: null })
  g9 = coord._gcWorkerRow('tab_no_hb', {})
  ok('a row with no parseable heartbeat is refused, not collected',
     g9 && g9.ok === false && g9.reason === 'not_quiet_enough', JSON.stringify(g9))

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURES')
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error('THREW', e); process.exit(1) })
