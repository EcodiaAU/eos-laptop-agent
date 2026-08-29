'use strict'

// reap-leaked-worker-tabs - drain the backlog of IDE chat tabs left open by
// workers that finished cleanly and could not close themselves.
//
// WHY THIS EXISTS. Until 2026-08-29 the close path resolved a worker's own tab
// through handles derived from the dispatch brief, and a recurring cron re-fires
// one brief verbatim, so from fire 2 onward the resolver was ambiguous by
// construction and correctly refused. The tabs accreted. Measured that morning:
// ~80 open, three Code Helper (Renderer) processes holding 3993 MB. Tate
// 2026-08-16: "If you go oom the vscode clause code tabs crash and it kills your
// scheduled tasks ability to spawn." The forward fix is the stable tab id
// captured at signal_bound; this is the one-off that clears what already leaked.
// scripts/mac-resource-guard.sh does not cover it: it counts Claude Code
// processes and its safety posture explicitly excludes VS Code helpers.
//
// THE RULE, and it is deliberately narrow. A tab is reaped ONLY when every one
// of these holds. Any single doubt preserves the tab. Better a leaked ghost than
// a closed live worker or a closed human chat, which is the 2026-07-21 mass-close
// lesson and it still governs.
//   1. Exactly one worker session anchor resolves to that live tab, by EXACT
//      label. A truncation-prefix guess is not an identity here.
//   2. That anchor's worker registry row has terminated_at set.
//   3. That worker has written NO transcript turn inside the liveness window.
//      This is worker-liveness.liveTabs, the same unforgeable signal the lease
//      side uses; a second liveness rule would be a second thing to get wrong.
//   4. No OTHER anchor, fresh or stale, resolves to the same live tab.
//   5. No NON-terminated worker row claims that tab id or that stable ttab id.
//   6. The label is not generic ('Claude Code' and kin). A generic label is what
//      every untitled tab and the conductor share; it can never identify one.
//   7. tab-close-guard.evaluateClose allows it with NO selfClose, so the
//      active-tab belt and the conductor-label belt both apply unweakened.
//
// FAILS SAFE. If the IDE bridge is unreachable, if the conductor is
// unregistered, or if the liveness probe throws, this reaps NOTHING and says so.
// A missed collection costs a webview; a wrong close kills live work.
//
// Usage:
//   node tools/reap-leaked-worker-tabs.js              # dry run, prints the set
//   node tools/reap-leaked-worker-tabs.js --apply      # close them
//   node tools/reap-leaked-worker-tabs.js --apply --limit 10
//   node tools/reap-leaked-worker-tabs.js --window 60  # liveness window minutes

const fs = require('fs')
const os = require('os')
const path = require('path')

const COORD_ROOT = process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')
const WORKERS_DIR = path.join(COORD_ROOT, 'workers')
const CHAT_TABS_DIR = path.join(COORD_ROOT, 'chat-tabs')
const CC = 'mainThreadWebview-claudeVSCodePanel'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  if (i === -1 || !argv[i + 1]) return dflt
  const n = Number(argv[i + 1])
  return Number.isFinite(n) ? n : dflt
}
const LIMIT = argOf('--limit', Infinity)
const WINDOW_MIN = argOf('--window', 45)

const coord = require('./coord')
const guard = require('./tab-close-guard')
const liveness = require('./worker-liveness')
const ide = require('./ide')

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }
const GENERIC = new Set(['', 'claude code', 'new chat', 'cursor', 'chat', 'untitled'])
const isGeneric = (s) => GENERIC.has(String(s || '').trim().toLowerCase())

function allWorkerRows() {
  const out = new Map()
  let files = []
  try { files = fs.readdirSync(WORKERS_DIR).filter((f) => f.endsWith('.json')) } catch (e) { return out }
  for (const f of files) {
    const row = readJson(path.join(WORKERS_DIR, f))
    if (row) out.set(f.slice(0, -5), row)
  }
  return out
}

function allWorkerAnchors() {
  const out = []
  let files = []
  try { files = fs.readdirSync(CHAT_TABS_DIR).filter((f) => f.endsWith('.json') && f[0] !== '_') } catch (e) { return out }
  for (const f of files) {
    const rec = readJson(path.join(CHAT_TABS_DIR, f))
    if (rec && rec.label && rec.tab_id) out.push(rec)
  }
  return out
}

// RUN ONLY WHEN INVOKED DIRECTLY (2026-08-29, live P0).
//
// index.js autoloads EVERY .js in tools/ (lib/tool-autoload.js), and its skip
// regex covers test harness names only. This file exports nothing and is a
// top-level async IIFE ending in process.exit(0) on its default dry-run path, so
// merely requiring it RAN it and then killed the host process with a clean exit
// code. launchd (KeepAlive, ThrottleInterval=10) respawned every 10s forever:
// the agent booted, printed the full tool list, printed this reaper's dry-run
// JSON, exited 0, repeat. 92 runs, no scheduler, no dispatch, no coord server.
//
// It was a delayed-action landmine. The running agent had booted BEFORE this
// file was added to tools/, so it held a module set that never contained it and
// stayed healthy for hours. Nothing detonated until the next restart, which made
// the restart look like the cause and this file look innocent.
//
// A one-shot CLI script dropped into an autoloaded directory is a boot-time
// hazard, and self-executing plus process.exit makes it a fatal one. The
// require.main guard is the fix at the source: direct `node tools/reap-leaked-
// worker-tabs.js` is unchanged, and a require is inert.
if (require.main === module) main()

async function main() {
  const report = {
    at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    window_minutes: WINDOW_MIN,
    live_tabs_seen: 0,
    candidates: [],
    preserved: [],
    closed: [],
    failed: [],
  }

  const conductor = coord._loadConductorRegistration()
  if (!conductor || !conductor.ide_bridge_port) {
    console.log(JSON.stringify({ ok: false, refused: 'no_conductor_ide_port, reaping nothing (fail-safe)' }, null, 2))
    process.exit(1)
  }

  let liveTabsIde
  try { liveTabsIde = await coord._liveCcTabsWithIds(conductor.ide_bridge_port) }
  catch (e) {
    console.log(JSON.stringify({ ok: false, refused: 'bridge_unreachable, reaping nothing (fail-safe): ' + (e.message || e) }, null, 2))
    process.exit(1)
  }
  if (!liveTabsIde || !liveTabsIde.length) {
    console.log(JSON.stringify({ ok: false, refused: 'no_live_tabs, reaping nothing (fail-safe)' }, null, 2))
    process.exit(1)
  }
  report.live_tabs_seen = liveTabsIde.length

  let liveWriters
  try { liveWriters = liveness.liveTabs(WINDOW_MIN) }
  catch (e) {
    console.log(JSON.stringify({ ok: false, refused: 'liveness_probe_threw, reaping nothing (fail-safe): ' + (e.message || e) }, null, 2))
    process.exit(1)
  }

  const rows = allWorkerRows()
  const anchors = allWorkerAnchors()

  // Signal 5 precomputed: everything a NON-terminated worker row claims.
  const liveClaimedTtab = new Set()
  const liveClaimedTabIds = new Set()
  for (const [id, row] of rows.entries()) {
    if (row.terminated_at) continue
    liveClaimedTabIds.add(id)
    const t = row.tab_handle && row.tab_handle.tabId
    if (t) liveClaimedTtab.add(t)
  }

  // Resolve each anchor to a live tab by EXACT label. Signal 1 and 4 both fall
  // out of this map: an anchor with several exact-label hits is not resolved,
  // and a live tab claimed by more than one anchor is dropped entirely.
  const byTtab = new Map()   // ttab id -> [{anchor, tab}]
  for (const a of anchors) {
    const exact = liveTabsIde.filter((t) => t.label === a.label && t.tabId)
    if (exact.length !== 1) continue
    const tab = exact[0]
    if (!byTtab.has(tab.tabId)) byTtab.set(tab.tabId, [])
    byTtab.get(tab.tabId).push({ anchor: a, tab: tab })
  }

  const conductorTabIds = new Set(['conductor'])
  if (conductor.tab_id) conductorTabIds.add(conductor.tab_id)

  for (const [ttab, claims] of byTtab.entries()) {
    const first = claims[0]
    const tab = first.tab
    const note = (reason, extra) => report.preserved.push(Object.assign(
      { ttab: ttab, label: tab.label, tab_id: first.anchor.tab_id, reason: reason }, extra || {}))

    if (claims.length !== 1) { note('multiple_anchors_claim_this_tab', { claimants: claims.length }); continue }
    const tabId = first.anchor.tab_id
    if (conductorTabIds.has(tabId)) { note('conductor_tab'); continue }
    if (first.anchor.role !== 'worker') { note('anchor_is_not_a_worker', { role: first.anchor.role || null }); continue }
    if (isGeneric(tab.label)) { note('generic_label_is_not_an_identity'); continue }
    if (liveClaimedTtab.has(ttab)) { note('stable_id_claimed_by_a_live_worker'); continue }
    if (liveClaimedTabIds.has(tabId)) { note('worker_row_is_not_terminated'); continue }

    const row = rows.get(tabId)
    if (!row) { note('no_registry_row'); continue }
    if (!row.terminated_at) { note('worker_row_is_not_terminated'); continue }
    if (liveWriters.has(tabId)) {
      note('wrote_a_transcript_turn_inside_the_window', {
        transcript_age_min: Math.round((Date.now() - liveWriters.get(tabId)) / 60000),
      })
      continue
    }
    const decision = guard.evaluateClose('reaper_anchor_exact_label', {
      label: tab.label, active: tab.active, index: tab.index, viewColumn: tab.viewColumn,
      // 2026-08-29: belt 2 identifies the conductor by stable tab id first, so
      // hand it the id we already keyed this whole loop on.
      tabId: tab.tabId || ttab || null,
    }, conductor)
    if (!decision.allow) { note('close_guard:' + decision.reason); continue }

    report.candidates.push({
      ttab: ttab, tab_id: tabId, label: tab.label,
      viewColumn: tab.viewColumn, index: tab.index,
      session_id: first.anchor.session_id,
      terminated_at: row.terminated_at,
      closed_tab_refused_reason: row.closed_tab_refused_reason || null,
    })
  }

  report.candidate_count = report.candidates.length
  report.preserved_count = report.preserved.length

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(0)
  }

  // Close highest index first so the earlier indices this pass still holds stay
  // valid as tabs are removed from the group.
  const ordered = report.candidates.slice().sort((a, b) => b.index - a.index).slice(0, LIMIT)
  for (const c of ordered) {
    try {
      const res = await ide.tabs_close({
        viewColumn: c.viewColumn,
        viewType: CC,
        exactLabel: c.label,   // race guard: bridge refuses if the slot moved
        tabIndex: c.index,
        ide_port: conductor.ide_bridge_port,
      })
      const inner = (res && res.result) || res || {}
      const closed = (typeof inner.closed === 'number' ? inner.closed > 0 : !!inner.ok)
      if (closed) {
        report.closed.push(c)
        try {
          const row = rows.get(c.tab_id)
          row.closed_tab_at = new Date().toISOString()
          row.closed_tab_ok = true
          row.closed_tab_strategy = 'backlog_reaper_anchor_exact_label'
          fs.writeFileSync(path.join(WORKERS_DIR, c.tab_id + '.json'), JSON.stringify(row))
        } catch (e) {}
      } else {
        report.failed.push(Object.assign({ refused: inner.refused || 'closed=0' }, c))
      }
    } catch (e) {
      report.failed.push(Object.assign({ error: (e && e.message) || String(e) }, c))
    }
  }
  report.closed_count = report.closed.length
  report.failed_count = report.failed.length
  console.log(JSON.stringify(report, null, 2))
}

// Kept identical to the prior tail: a throw still reports and exits non-zero,
// but only on the direct-invocation path above.
if (require.main === module) {
  process.on('unhandledRejection', (e) => {
    console.error('THREW: ' + ((e && e.stack) || e))
    process.exit(1)
  })
}
