'use strict'

// Regression test for the close handoff signal_done owes the orphan sweep
// (2026-09-01).
//
// THE DEFECT. A worker is instructed to call coord.close_my_tab as its final
// action. Measured over 14 days of transcripts on this host, 1,584 sessions
// reached signal_done and 176 of them (11.1 pct) never called it. That is the
// compliance floor for an instruction read at the top of a long arc, not an
// anomaly, so the tab close cannot be priced as if the model guarantees it.
//
// The backstop for that population is cowork.cleanup_orphan_workers, sweeping
// every 7 minutes over rows carrying terminated_at. Its Pass 0 closes on the
// stable tab id and it is effective ONLY there: aggregated over this host's whole
// agent log it closed 90 tabs by stable_tab_id and 5 by sentinel_prefix, while
// refusing 365 times with no_match and 276 times with
// fuzzy_fingerprint_refused_not_positive_id. Both refusals are one condition,
// the row reached the sweep with no usable stable id, so the fuzzy ladder ran and
// correctly declined to guess. Such a row leaks forever: nothing later in its
// life ever captures an id again.
//
// signal_bound captures one, but bind time is the worst moment in the arc. The
// tab is still wearing its provisional "Claude Code" label and autotitles seconds
// later, and the bridge mints a fresh ttab id for a tab that both retitles and
// reorders between listings. close_my_tab recaptures, but only for the workers
// that call it, which is precisely the population that does not need repairing.
//
// THE FIX. signal_done captures at done time, the strongest moment in the arc:
// the tab is provably alive because it is mid-tool-call, its label is final, and
// the worker's own turn put it in front of the bridge.
//
// What this test does NOT assert, deliberately: that signal_done closes the tab.
// It must not. 144 of those 176 sessions kept working for six or more entries
// after the done call, and a close wired here would truncate their durability
// writes. The sweep owns the close behind its own belts; signal_done only makes
// the tab identifiable.
//
// Every assertion is paired with a control that differs only in the variable
// under test. Doctrine:
// a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-signal-done-close-handoff.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-close-handoff-'))
process.env.COORD_ROOT = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'conductors'), { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'chat-tabs'), { recursive: true })
fs.writeFileSync(
  path.join(tmpRoot, 'conductors', 'current.json'),
  JSON.stringify({ tab_id: 'conductor', ide_bridge_port: 65535, title_match: 'CONDUCTOR OWN CHAT' })
)

const coord = require('./coord')
const ide = require('./ide')

// The scheduler-visible completion is a Postgres write. Stub it: this file is
// about the close handoff, and a real recordDone would make the test depend on a
// live database and on a scheduled row that does not exist.
const taskSignals = require('./task-signals')
taskSignals.recordDone = async () => ({ ok: true, stubbed: true })

const CC = 'mainThreadWebview-claudeVSCodePanel'

let LIVE_TABS = []
ide.tabs = async () => ({
  groups: [{
    viewColumn: 1,
    isActive: true,
    tabs: LIVE_TABS.map((t, i) => Object.assign({ viewType: CC, index: i }, t)),
  }],
})
let closeCalls = 0
ide.tabs_close = async () => { closeCalls++; return { closed: 1, matched: 1 } }

let fails = 0
function ok(name, cond, extra) {
  if (cond) { console.log('  PASS: ' + name) }
  else { console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); fails++ }
}

function mkWorker(tab_id, sentinel) {
  coord._registerWorkerInternal({ tab_id: tab_id, task_id: 'close-handoff-row', tab_credential: 'cred-' + tab_id })
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
function diskRow(tab_id) {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'workers', tab_id + '.json'), 'utf8'))
}
// The predicate cowork.cleanup_orphan_workers actually selects and resolves on:
// terminated, not already closed, and carrying a stable id for its Pass 0.
function sweepCanClose(row) {
  const th = (row && row.tab_handle) || {}
  return !!row.terminated_at && row.closed_tab_ok !== true && !!th.tabId
}

;(async () => {
  console.log('\n== Part 1: a worker that never calls close_my_tab still hands the sweep an id ==')

  const SENT_A = '[a1b2 close handoff resolvable]'
  mkWorker('w-resolvable', SENT_A)
  // The live tab wears this row's sentinel and nothing else claims it. This is
  // the ordinary shape at done time: the autotitle has settled and the tab is up.
  LIVE_TABS = [
    { tabId: 'ttab_resolvable_1_1', label: SENT_A, viewColumn: 1, index: 0 },
    { tabId: 'ttab_unrelated_1_1', label: 'Some human chat about invoices', viewColumn: 1, index: 1 },
  ]

  const before = diskRow('w-resolvable')
  ok('CONTROL: the row starts with no stable tab id, so the sweep could not close it',
    !before.tab_handle.tabId && !sweepCanClose(before), JSON.stringify(before.tab_handle))

  const res = await coord.signal_done(
    { task_id: 'close-handoff-row', status: 'success', result_summary: 'done', terminate: true },
    { tab_id: 'w-resolvable' }
  )

  const after = diskRow('w-resolvable')
  ok('THE FIX: signal_done captured the stable tab id onto the durable row',
    after.tab_handle.tabId === 'ttab_resolvable_1_1', JSON.stringify(after.tab_handle))
  ok('THE FIX: the row now satisfies the sweep\'s own close predicate',
    sweepCanClose(after), JSON.stringify({ terminated_at: after.terminated_at, closed_tab_ok: after.closed_tab_ok, tabId: after.tab_handle.tabId }))
  ok('the leak is countable: close_owed_at is stamped and no close has landed',
    !!after.close_owed_at && !after.closed_tab_at, JSON.stringify({ owed: after.close_owed_at, closed: after.closed_tab_at }))
  ok('the response nudges the worker to close it itself',
    res.close_owed === true && res.next_action === 'coord.close_my_tab', JSON.stringify({ close_owed: res.close_owed, next_action: res.next_action }))
  ok('the response reports the capture outcome',
    res.close_handoff && res.close_handoff.captured === true && res.close_handoff.stable_tab_id === 'ttab_resolvable_1_1',
    JSON.stringify(res.close_handoff))
  ok('CONTROL: signal_done did NOT close the tab (144 of 176 keep working after done)',
    closeCalls === 0, 'ide.tabs_close calls=' + closeCalls)
  ok('CONTROL: the scheduler-visible completion still governs ok',
    res.ok === true, JSON.stringify({ ok: res.ok, signal: res.signal }))

  console.log('\n== Part 2: an unresolvable tab is left unidentified, never guessed ==')

  const SENT_B = '[c3d4 close handoff unresolvable]'
  mkWorker('w-unresolvable', SENT_B)
  // Same call, one variable changed: no live tab wears this row's sentinel.
  LIVE_TABS = [
    { tabId: 'ttab_unrelated_1_1', label: 'Some human chat about invoices', viewColumn: 1, index: 0 },
  ]

  const res2 = await coord.signal_done(
    { task_id: 'close-handoff-row', status: 'success', result_summary: 'done', terminate: true },
    { tab_id: 'w-unresolvable' }
  )
  const after2 = diskRow('w-unresolvable')

  ok('fail-safe: no id is invented when nothing resolves',
    !after2.tab_handle.tabId, JSON.stringify(after2.tab_handle))
  ok('CONTROL: this row does NOT satisfy the sweep predicate, so Part 1 discriminates',
    !sweepCanClose(after2), JSON.stringify(after2.tab_handle))
  ok('the miss is still countable: close_owed_at stamped, capture reported false with a reason',
    !!after2.close_owed_at && res2.close_handoff.captured === false && !!res2.close_handoff.reason,
    JSON.stringify({ owed: after2.close_owed_at, handoff: res2.close_handoff }))
  ok('CONTROL: terminated_at is stamped on both rows regardless of capture outcome',
    !!after2.terminated_at && !!after.terminated_at, JSON.stringify({ a: after.terminated_at, b: after2.terminated_at }))

  console.log('\n== Part 3: a caller with no tab identity is not told a tab is owed ==')
  const res3 = await coord.signal_done(
    { task_id: 'close-handoff-row', status: 'success', result_summary: 'done', terminate: true },
    {}
  )
  ok('no tab_id means no close is owed and no next_action is asserted',
    res3.close_owed === false && res3.next_action === null, JSON.stringify({ close_owed: res3.close_owed, next_action: res3.next_action }))

  console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILED'))
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
