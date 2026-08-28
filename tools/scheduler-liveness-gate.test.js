'use strict'

// Regression test for the gate that let the scheduler destroy its own live
// cron workers (status_board 8d28c32d, P1, 2026-08-29).
//
// THE DEFECT. hasLiveWorkerForTask is the ONLY thing standing between a running
// worker and a reclaim that rm -rf's its isolated worktree (pruneWorktreeForRow)
// with its uncommitted work inside. Its only liveness signal was the coord
// heartbeat, and 78 of 114 coord worker rows carry last_heartbeat_at EXACTLY
// equal to registered_at: they beat once at boot and never again, so 68.4 pct of
// workers go invisible to this gate 180 seconds after they start.
// Proven instance 2026-08-28: cron row f0c904df (status-board-execute-top) took
// "running orphan-timeout" at 18:41Z while its worker tab ran on until 18:44:56Z.
//
// THE FIX UNDER TEST. tools/worker-liveness.js derives a verdict from transcript
// mtime, a file the Claude Code harness writes every turn with no cooperation
// from the model. hasLiveWorkerForTask now consults it as a SECOND CHANCE TO FIND
// THE WORKER ALIVE: live and unknown both refuse the reclaim, only dead falls
// through. livenessReapPass already reasoned this way; the gate that destroys did
// not.
//
// Every refusal assertion below is PAIRED with a control that differs only in the
// variable under test, because a check that cannot fail is not a check. The two
// that matter most: the 'dead' arm (proves the gate is fixed, not merely
// disabled) and the default-off arm (proves the callers we deliberately did NOT
// enable are byte-identical to today).
// Doctrine: a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24
//
// Run: node tools/scheduler-liveness-gate.test.js

process.env.COORD_DISABLE_SWEEP = '1'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused/unused'

const os = require('os')
const path = require('path')
const fs = require('fs')

// worker-liveness reads these at module load, so they must be set before the
// first require of it. scheduler.js requires it lazily inside the function.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-liveness-gate-'))
const TRANSCRIPTS = path.join(tmpRoot, 'projects')
const WORKTREES = path.join(tmpRoot, 'worktrees')
const WORKERS = path.join(tmpRoot, 'workers')
for (const d of [TRANSCRIPTS, WORKTREES, WORKERS]) fs.mkdirSync(d, { recursive: true })
process.env.EOS_TRANSCRIPTS_DIR = TRANSCRIPTS
process.env.EOS_WORKTREES_DIR = WORKTREES
process.env.EOS_COORD_WORKERS_DIR = WORKERS

const scheduler = require('./scheduler')

const TASK = 'aaaaaaaa-1111-2222-3333-444444444444'
const TAB = 'tab_1787900000000_ab12cd34'
const MIN = 60_000

// A transcript whose head carries the dispatched-worker boot envelope, which is
// what worker-liveness uses to decide the file OWNS the tab. mtime is the signal.
function writeTranscript(tabId, ageMinutes) {
  const p = path.join(TRANSCRIPTS, tabId + '.jsonl')
  fs.writeFileSync(p, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<dispatched role="worker" tab_id="' + tabId + '"/>' },
  }) + '\n')
  const t = (Date.now() - ageMinutes * MIN) / 1000
  fs.utimesSync(p, t, t)
  return p
}
function clearTranscripts() {
  for (const f of fs.readdirSync(TRANSCRIPTS)) fs.unlinkSync(path.join(TRANSCRIPTS, f))
}

// The row the fallback path fetches for itself. Branch 3's own SELECT does not
// fetch leased_at, so the function must read it rather than trust the caller:
// a null leased_at reads as the boot race and would refuse FOREVER.
function stubPool(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) }
}
function row(overrides) {
  return Object.assign({
    id: TASK, name: 'cowork.test-lane-T1', dispatched_tab_id: TAB,
    leased_at: new Date(Date.now() - 30 * MIN).toISOString(),
  }, overrides || {})
}
const coordSilent = { list_workers: async () => ({ workers: [] }) }
const coordStale = { list_workers: async () => ({ workers: [
  { task_id: TASK, tab_id: TAB, stale_ms: 9_000_000, terminated_at: null }] }) }
const coordLive = { list_workers: async () => ({ workers: [
  { task_id: TASK, tab_id: TAB, stale_ms: 5_000, terminated_at: null }] }) }
const coordDown = { list_workers: async () => { throw new Error('ECONNREFUSED 127.0.0.1:7456') } }

let fails = 0
function ok(name, cond, extra) {
  if (cond) { console.log('  PASS  ' + name) }
  else { fails++; console.log('  FAIL  ' + name + (extra ? '   [' + extra + ']' : '')) }
}

const call = (opts) => scheduler._hasLiveWorkerForTask(TASK, opts)
const FB = { transcriptFallback: true }

;(async () => {
  console.log('\n-- the four arms --')

  // ARM 1. coord says live. Unchanged behaviour, and it must not need the oracle.
  clearTranscripts()
  scheduler._setCoord(coordLive); scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  let r = await call(FB)
  ok('ARM 1 coord-live returns the coord worker, not a transcript verdict',
    !!r && r.tab_id === TAB && r.source !== 'transcript-mtime', JSON.stringify(r))

  // ARM 2. coord silent, transcript written 2 minutes ago. The worker is alive
  // and the heartbeat simply never fired. THIS is the 68.4 pct.
  clearTranscripts(); writeTranscript(TAB, 2)
  scheduler._setCoord(coordSilent); scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('ARM 2 coord-silent + fresh transcript -> LIVE, reclaim refused',
    !!r && r.source === 'transcript-mtime' && r.verdict === 'live' && r.tab_id === TAB, JSON.stringify(r))

  // ARM 3. coord silent, NO transcript, leased 30 min ago, registry does not
  // record the worker terminated. Inside the confirm window this is an absence,
  // not evidence of death. This is the arm that stops the deletions.
  clearTranscripts()
  scheduler._setCoord(coordSilent); scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('ARM 3 coord-silent + no evidence either way -> UNKNOWN treated as live, reclaim refused',
    !!r && r.source === 'transcript-mtime' && r.verdict === 'unknown', JSON.stringify(r))

  // ARM 4. THE CONTROL THAT PROVES THE GATE IS FIXED AND NOT MERELY DISABLED.
  // Silent on every surface and past the confirmation window. Genuinely dead.
  clearTranscripts()
  scheduler._setCoord(coordSilent)
  scheduler._setPool(stubPool(row({ leased_at: new Date(Date.now() - 90 * MIN).toISOString() })))
  scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('ARM 4 CONTROL coord-silent + dead on every surface -> null, reclaim PROCEEDS',
    r === null, JSON.stringify(r))

  console.log('\n-- coord stale is the same case as coord silent --')
  clearTranscripts(); writeTranscript(TAB, 2)
  scheduler._setCoord(coordStale); scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('a coord row past STALE_WORKER_LIVENESS_MS still reaches the oracle',
    !!r && r.source === 'transcript-mtime', JSON.stringify(r))

  console.log('\n-- the opt-in is real: callers we did NOT enable are unchanged --')
  clearTranscripts(); writeTranscript(TAB, 2)
  scheduler._setCoord(coordSilent); scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  r = await call()
  ok('default (no opt) ignores a LIVE transcript and returns null, exactly as today',
    r === null, JSON.stringify(r))
  r = await call({ transcriptFallback: false })
  ok('explicit false does the same', r === null, JSON.stringify(r))

  console.log('\n-- the narrowing: no tab id is an absence that can never change --')
  clearTranscripts(); writeTranscript(TAB, 2)
  scheduler._setCoord(coordSilent)
  scheduler._setPool(stubPool(row({ dispatched_tab_id: null }))); scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('row with no dispatched_tab_id falls through rather than wedging its only reclaim path',
    r === null, JSON.stringify(r))

  // Control for the narrowing: same row, same everything, tab id restored.
  scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('CONTROL same fixture WITH a tab id does refuse, so the narrowing is the variable',
    !!r && r.verdict === 'live', JSON.stringify(r))

  console.log('\n-- coord unreachable: the oracle is local disk and still answers --')
  clearTranscripts(); writeTranscript(TAB, 2)
  scheduler._setCoord(coordDown); scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('coord down + live transcript -> LIVE (a blind prune is least defensible during an outage)',
    !!r && r.source === 'transcript-mtime' && r.verdict === 'live', JSON.stringify(r))

  clearTranscripts()
  scheduler._setCoord(coordDown)
  scheduler._setPool(stubPool(row({ leased_at: new Date(Date.now() - 90 * MIN).toISOString() })))
  scheduler._resetLiveTabsMemo()
  r = await call(FB)
  ok('CONTROL coord down + dead on every surface -> null, so an outage does not block recovery',
    r === null, JSON.stringify(r))

  console.log('\n-- a probe that throws is not evidence of death --')
  clearTranscripts()
  scheduler._setCoord(coordSilent); scheduler._setPool(stubPool(row())); scheduler._resetLiveTabsMemo()
  r = await call({ transcriptFallback: true, liveness: { probeRows() { throw new Error('boom') },
    liveTabs() { return new Map() } } })
  ok('probeRows throwing -> refuse the reclaim (safe direction)',
    !!r && r.verdict === 'unknown' && /boom/.test(String(r.reason)), JSON.stringify(r))

  console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'))
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => { console.error('THREW: ' + (e && e.stack || e)); process.exit(1) })
