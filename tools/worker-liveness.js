'use strict'

// worker-liveness - the one observed liveness fact the whole dispatch system was missing.
//
// WHY (2026-08-28, coord rebuild lane R1). Four consumers each held a different
// answer to "is this job still alive", and none of them held a fact:
//   coord.list_workers  a heartbeat the worker must remember to send, 90s deadline
//   the lane guard      status IN ('active','paused'), so a running holder is invisible
//   the scheduler       status='running', which only says nobody reported otherwise
//   the inbox           one shared seen_at, so "read" meant "somebody read it"
// Measured 2026-08-28T06:26Z: coord.list_workers returned 1 while 24 sessions had
// written a turn in the previous three minutes. Sixteen commits in ten days each
// corrected one consumer's guess; none of them created something true.
//
// THE SIGNAL. The Claude Code harness appends to
// ~/.claude/projects/<project>/<session>.jsonl on every turn, with no cooperation
// from the model. A worker cannot fail to emit it while working and cannot emit
// it after it stops, so its mtime is unforgeable in both directions. Every worker
// transcript carries its own tab_id in the boot envelope (turn 1), so the file
// identifies itself.
//
// THE INVERSION THAT MAKES IT CHEAP. Do not ask "where is tab X's transcript",
// which means grepping 267MB. Ask "which tabs wrote a turn recently": stat the
// project tree, keep only files newer than the window, read the first 256KB of
// each for its own tab id. Measured 0.17s for a 30-minute window (35 files, 27
// live tabs) versus 5.0s for the full grep, and it answers every row at once.
//
// FAILS TOWARD THE STATUS QUO. The verdict vocabulary is live / dead / unknown,
// and only `dead` is actionable. A row too young to have a transcript, a probe
// that throws, a tab with no evidence either way, all return `unknown`, which
// every caller treats as "leave it alone". Reaping nothing is always safe.
//
// Doctrine: patterns/running-is-not-liveness-transcript-mtime-is-2026-08-27.md

const fs = require('fs')
const os = require('os')
const path = require('path')

const PROJECTS_DIR = process.env.EOS_TRANSCRIPTS_DIR ||
  path.join(os.homedir(), '.claude', 'projects')
const WORKTREES_DIR = process.env.EOS_WORKTREES_DIR ||
  path.join(os.homedir(), '.code', 'ecodiaos', '_worktrees', 'dispatched')
const WORKERS_DIR = process.env.EOS_COORD_WORKERS_DIR ||
  path.join(os.homedir(), '.ecodiaos', 'coordination', 'workers')

// A live session writes a turn every few seconds to a few minutes. 30 minutes is
// generous on purpose: a worker inside one long Bash call (a build, a test suite,
// an ASC upload) is silent for minutes at a time and must not be reaped for it.
// This is the number the 90s heartbeat got catastrophically wrong.
const DEFAULT_WINDOW_MIN = 30
// A row leased less than this ago has not necessarily written turn 1 yet. Never
// reap inside it: that is the boot race, and it would kill workers on spawn.
const DEFAULT_BOOT_GRACE_MIN = 10
const HEAD_BYTES = 262_144
const TAB_RE = /tab_17\d{11}_[a-f0-9]{8}/

// liveTabs(windowMinutes) -> Map<tab_id, mtimeMs>
// Every tab that has written a transcript turn inside the window.
function liveTabs(windowMinutes) {
  const win = (typeof windowMinutes === 'number' ? windowMinutes : DEFAULT_WINDOW_MIN) * 60_000
  const cutoff = Date.now() - win
  const out = new Map()
  let stack = [PROJECTS_DIR]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { continue }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!e.name.endsWith('.jsonl')) continue
      let st
      try { st = fs.statSync(p) } catch (err) { continue }
      if (st.mtimeMs < cutoff) continue
      let head
      try {
        const fd = fs.openSync(p, 'r')
        try {
          const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size))
          fs.readSync(fd, buf, 0, buf.length, 0)
          head = buf.toString('utf8')
        } finally { fs.closeSync(fd) }
      } catch (err) { continue }
      const m = TAB_RE.exec(head)
      if (!m) continue
      const prev = out.get(m[0])
      if (!prev || st.mtimeMs > prev) out.set(m[0], st.mtimeMs)
    }
  }
  return out
}

// Newest mtime anywhere under a dispatched worktree. A worker that is editing
// files is alive even if its transcript moved (a resumed session writes a new
// jsonl). Cheap fallback keyed by task_id, capped so a huge tree cannot stall
// the tick.
function worktreeMtime(taskId, maxEntries) {
  if (!taskId) return null
  const root = path.join(WORKTREES_DIR, String(taskId))
  let newest = null, seen = 0
  const cap = maxEntries || 4000
  let stack = [root]
  while (stack.length && seen < cap) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { continue }
    for (const e of entries) {
      if (seen++ > cap) break
      if (e.name === '.git' || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      try {
        const st = fs.statSync(p)
        if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
      } catch (err) {}
    }
  }
  return newest
}

function registryRow(tabId) {
  if (!tabId) return null
  try { return JSON.parse(fs.readFileSync(path.join(WORKERS_DIR, tabId + '.json'), 'utf8')) }
  catch (e) { return null }
}

// probeRows(rows, opts) -> [{ id, name, tab_id, verdict, reason, evidence }]
// rows: os_scheduled_tasks rows in status='running'.
// verdict is one of 'live' | 'dead' | 'unknown'. ONLY 'dead' is actionable.
function probeRows(rows, opts) {
  opts = opts || {}
  const windowMin = typeof opts.window_minutes === 'number' ? opts.window_minutes : DEFAULT_WINDOW_MIN
  const graceMin = typeof opts.boot_grace_minutes === 'number' ? opts.boot_grace_minutes : DEFAULT_BOOT_GRACE_MIN
  const now = opts.now_ms || Date.now()
  const live = opts.live_tabs || liveTabs(windowMin)
  const out = []

  for (const r of rows || []) {
    const tabId = r.dispatched_tab_id || null
    const leasedMs = r.leased_at ? new Date(r.leased_at).getTime() : null
    const ageMin = leasedMs ? (now - leasedMs) / 60_000 : null
    const ev = { tab_id: tabId, leased_age_min: ageMin === null ? null : Math.round(ageMin) }

    // 1. A turn inside the window is proof of life and outranks everything else,
    //    including a registry row that says terminated.
    if (tabId && live.has(tabId)) {
      ev.transcript_age_min = Math.round((now - live.get(tabId)) / 60_000)
      out.push({ id: r.id, name: r.name, tab_id: tabId, verdict: 'live',
        reason: 'transcript turn inside the window', evidence: ev })
      continue
    }

    // 2. Boot race. Too young to have proven anything either way.
    if (ageMin === null || ageMin < graceMin) {
      out.push({ id: r.id, name: r.name, tab_id: tabId, verdict: 'unknown',
        reason: 'leased less than ' + graceMin + 'm ago, no transcript yet', evidence: ev })
      continue
    }

    // 3. No transcript at all for this tab. That is not evidence of death: the
    //    row may predate transcript retention, or carry no tab id. Refuse to guess.
    if (!tabId) {
      out.push({ id: r.id, name: r.name, tab_id: null, verdict: 'unknown',
        reason: 'row carries no dispatched_tab_id', evidence: ev })
      continue
    }

    // 4. Working tree still being written counts as alive.
    const wt = worktreeMtime(r.task_id || r.id)
    if (wt && (now - wt) < windowMin * 60_000) {
      ev.worktree_age_min = Math.round((now - wt) / 60_000)
      out.push({ id: r.id, name: r.name, tab_id: tabId, verdict: 'live',
        reason: 'dispatched worktree written inside the window', evidence: ev })
      continue
    }
    if (wt) ev.worktree_age_min = Math.round((now - wt) / 60_000)

    // 5. Silent past the window on every observable surface. Dead.
    const reg = registryRow(tabId)
    ev.registry_terminated = !!(reg && reg.terminated_at)
    ev.registry_heartbeat_age_min = reg && (reg.last_heartbeat_at || reg.registered_at)
      ? Math.round((now - new Date(reg.last_heartbeat_at || reg.registered_at).getTime()) / 60_000)
      : null
    out.push({ id: r.id, name: r.name, tab_id: tabId, verdict: 'dead',
      reason: 'no transcript turn and no worktree write for ' + windowMin + 'm', evidence: ev })
  }
  return out
}

// Tool surface: probe every running row and report, mutating nothing.
async function report(params) {
  params = params || {}
  const scheduler = require('./scheduler')
  const pool = scheduler._poolForLiveness ? scheduler._poolForLiveness() : null
  if (!pool) return { ok: false, error: 'no pool available' }
  const res = await pool.query(
    `SELECT id, name, task_id, status, leased_at, dispatched_tab_id
       FROM os_scheduled_tasks WHERE status = 'running' AND archived_at IS NULL`)
  const verdicts = probeRows(res.rows, params)
  const counts = verdicts.reduce((a, v) => { a[v.verdict] = (a[v.verdict] || 0) + 1; return a }, {})
  return { ok: true, counts, running: res.rows.length, verdicts }
}

module.exports = {
  report,
  liveTabs, probeRows, worktreeMtime, registryRow,
  DEFAULT_WINDOW_MIN, DEFAULT_BOOT_GRACE_MIN,
}
