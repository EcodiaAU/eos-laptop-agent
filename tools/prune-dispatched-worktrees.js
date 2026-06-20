#!/usr/bin/env node
// tools/prune-dispatched-worktrees.js
//
// Safe-prune helper for leaked dispatched worktrees.
//
// 2026-06-20. The scheduler allocates a per-row isolated worktree at
// WORKTREE_ROOT/<row.id> (branch worker/<row.id>) for each dispatched worker
// (defaultAllocateWorktreeForRow in tools/scheduler.js) and is supposed to
// drop it on completion / failure / orphan / stale-lease via
// pruneWorktreeForRow. In practice 70+ dirs accumulate under
// /Users/ecodia/.code/ecodiaos/_worktrees/dispatched because the prune path
// does not always fire (cron-defer recovery, agent restart mid-task, a worker
// tab that died before signal_done). This helper sweeps those dirs and removes
// ONLY the ones that are provably safe to delete.
//
// SAFETY RULES (a dir is pruned only if ALL hold):
//   1. No live worker. Every coord worker-registry row whose task_id == the
//      dir name (the scheduler row.id) is terminated (terminated_at set) OR has
//      a stale heartbeat (last_heartbeat_at older than LIVE_HEARTBEAT_MS). If
//      ANY matching row is alive (no terminated_at AND fresh heartbeat) the dir
//      is SKIPPED. A dir with no matching registry row at all is treated as
//      safe (the worker is long gone) UNLESS --require-registry is passed.
//   2. No uncommitted work. `git status --porcelain` in the worktree is empty.
//      Any tracked-or-untracked change skips the dir (better leak than data
//      loss). A worktree git probe that errors also skips (fail safe).
//
// DRY-RUN BY DEFAULT. Pass --apply to actually remove. Removal uses
// `git -C <shared_tree> worktree remove --force <path>` then `worktree prune`,
// matching the scheduler's own pruneWorktreeForRow, with an rmdir fallback for
// dirs git no longer tracks.
//
// Usage:
//   node tools/prune-dispatched-worktrees.js                 # dry-run report
//   node tools/prune-dispatched-worktrees.js --apply         # actually prune
//   node tools/prune-dispatched-worktrees.js --json          # machine-readable
//   node tools/prune-dispatched-worktrees.js --require-registry
//
// Env overrides mirror scheduler.js + cowork.js so the helper reads the same
// substrate the live dispatcher writes:
//   SCHEDULER_WORKTREE_ROOT  (default /Users/ecodia/.code/ecodiaos/_worktrees/dispatched)
//   SCHEDULER_SHARED_TREE    (default /Users/ecodia/.code/ecodiaos/backend)
//   COORD_ROOT               (default ~/.ecodiaos/coordination on non-win32)

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const WORKTREE_ROOT = process.env.SCHEDULER_WORKTREE_ROOT
  || '/Users/ecodia/.code/ecodiaos/_worktrees/dispatched'
const SHARED_TREE = process.env.SCHEDULER_SHARED_TREE
  || '/Users/ecodia/.code/ecodiaos/backend'
const COORD_ROOT = process.env.COORD_ROOT
  || (process.platform === 'win32'
        ? 'D:\\.code\\EcodiaOS\\coordination'
        : path.join(os.homedir(), '.ecodiaos', 'coordination'))
const WORKERS_DIR = path.join(COORD_ROOT, 'workers')

// A worker heartbeat fresher than this means the worker is still considered
// live and its worktree must never be touched. Generous (1h) so a slow worker
// mid-task is never reaped: the scheduler's own ORPHAN_TIMEOUT is hours, and
// this prune is a maintenance broom, not a kill path.
const LIVE_HEARTBEAT_MS = 60 * 60 * 1000

function parseArgs(argv) {
  const a = { apply: false, json: false, requireRegistry: false }
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') a.apply = true
    else if (arg === '--json') a.json = true
    else if (arg === '--require-registry') a.requireRegistry = true
    else if (arg === '--help' || arg === '-h') a.help = true
  }
  return a
}

// Build task_id -> liveness summary from the coord worker registry.
// Returns Map<task_id, { rows, anyLive, allTerminated }>.
function loadRegistryByTask() {
  const byTask = new Map()
  let files = []
  try { files = fs.readdirSync(WORKERS_DIR).filter(f => f.endsWith('.json')) } catch (e) { return byTask }
  const now = Date.now()
  for (const f of files) {
    let w = null
    try { w = JSON.parse(fs.readFileSync(path.join(WORKERS_DIR, f), 'utf8')) } catch (e) { continue }
    const tid = w && w.task_id
    if (!tid) continue
    const hb = Date.parse(w.last_heartbeat_at || '')
    const freshHeartbeat = Number.isFinite(hb) && (now - hb) < LIVE_HEARTBEAT_MS
    const live = !w.terminated_at && freshHeartbeat
    const cur = byTask.get(tid) || { rows: 0, anyLive: false, allTerminated: true }
    cur.rows += 1
    if (live) cur.anyLive = true
    if (!w.terminated_at) cur.allTerminated = false
    byTask.set(tid, cur)
  }
  return byTask
}

function gitPorcelain(wtPath) {
  // Returns { ok, dirty, error }. Treat any probe error as dirty=unknown -> skip.
  try {
    const out = execFileSync('git', ['-C', wtPath, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, dirty: out.trim().length > 0, error: null }
  } catch (e) {
    return { ok: false, dirty: null, error: (e && e.message) || String(e) }
  }
}

function removeWorktree(wtPath) {
  // Mirror scheduler.pruneWorktreeForRow: worktree remove --force then prune.
  const env = Object.assign({}, process.env, { ECODIAOS_BRANCH_OK: '1' })
  let removed = false
  let err = null
  try {
    execFileSync('git', ['-C', SHARED_TREE, 'worktree', 'remove', '--force', wtPath], {
      encoding: 'utf8', timeout: 30_000, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    removed = true
  } catch (e) {
    err = (e && e.message) || String(e)
  }
  // prune dangling admin entries regardless.
  try {
    execFileSync('git', ['-C', SHARED_TREE, 'worktree', 'prune'], {
      encoding: 'utf8', timeout: 30_000, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {}
  // Fallback: git may no longer track the dir (already deregistered) yet the
  // directory lingers on disk. rmdir it directly if it still exists.
  if (fs.existsSync(wtPath)) {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); removed = true; err = null }
    catch (e) { err = err || ((e && e.message) || String(e)) }
  }
  return { removed: removed && !fs.existsSync(wtPath), error: err }
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 38).join('\n') + '\n')
    return
  }

  let dirs = []
  try {
    dirs = fs.readdirSync(WORKTREE_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch (e) {
    const out = { ok: false, error: 'cannot read WORKTREE_ROOT ' + WORKTREE_ROOT + ': ' + (e.message || e) }
    process.stdout.write((args.json ? JSON.stringify(out) : ('ERROR: ' + out.error)) + '\n')
    process.exit(1)
  }

  const registry = loadRegistryByTask()
  const decisions = []

  for (const name of dirs) {
    const wtPath = path.join(WORKTREE_ROOT, name)
    const reg = registry.get(name) || null

    // Rule 1: live worker check.
    if (reg && reg.anyLive) {
      decisions.push({ dir: name, action: 'skip', reason: 'worker_alive', registry_rows: reg.rows })
      continue
    }
    if (args.requireRegistry && !reg) {
      decisions.push({ dir: name, action: 'skip', reason: 'no_registry_row_and_require_registry', registry_rows: 0 })
      continue
    }

    // Rule 2: uncommitted-work check.
    const g = gitPorcelain(wtPath)
    if (!g.ok) {
      decisions.push({ dir: name, action: 'skip', reason: 'git_probe_error:' + g.error, registry_rows: reg ? reg.rows : 0 })
      continue
    }
    if (g.dirty) {
      decisions.push({ dir: name, action: 'skip', reason: 'uncommitted_changes', registry_rows: reg ? reg.rows : 0 })
      continue
    }

    // Safe to prune.
    if (!args.apply) {
      decisions.push({ dir: name, action: 'would_prune', reason: reg ? 'all_workers_terminated_clean' : 'no_registry_clean', registry_rows: reg ? reg.rows : 0 })
      continue
    }
    const rm = removeWorktree(wtPath)
    decisions.push({
      dir: name,
      action: rm.removed ? 'pruned' : 'prune_failed',
      reason: rm.removed ? (reg ? 'all_workers_terminated_clean' : 'no_registry_clean') : ('remove_error:' + rm.error),
      registry_rows: reg ? reg.rows : 0,
    })
  }

  const summary = {
    ok: true,
    dry_run: !args.apply,
    worktree_root: WORKTREE_ROOT,
    shared_tree: SHARED_TREE,
    coord_root: COORD_ROOT,
    total_dirs: dirs.length,
    would_prune: decisions.filter(d => d.action === 'would_prune').length,
    pruned: decisions.filter(d => d.action === 'pruned').length,
    prune_failed: decisions.filter(d => d.action === 'prune_failed').length,
    skipped: decisions.filter(d => d.action === 'skip').length,
    skip_breakdown: {
      worker_alive: decisions.filter(d => d.reason === 'worker_alive').length,
      uncommitted_changes: decisions.filter(d => d.reason === 'uncommitted_changes').length,
      git_probe_error: decisions.filter(d => String(d.reason).startsWith('git_probe_error')).length,
      no_registry_gated: decisions.filter(d => d.reason === 'no_registry_row_and_require_registry').length,
    },
    decisions,
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    return
  }

  const verb = args.apply ? 'PRUNED' : 'WOULD PRUNE (dry-run, pass --apply to act)'
  process.stdout.write('dispatched-worktree prune  [' + (args.apply ? 'APPLY' : 'DRY-RUN') + ']\n')
  process.stdout.write('  root: ' + WORKTREE_ROOT + '\n')
  process.stdout.write('  total dirs: ' + summary.total_dirs + '\n')
  process.stdout.write('  ' + verb + ': ' + (args.apply ? summary.pruned : summary.would_prune) + '\n')
  if (summary.prune_failed) process.stdout.write('  prune FAILED: ' + summary.prune_failed + '\n')
  process.stdout.write('  skipped: ' + summary.skipped
    + ' (worker_alive=' + summary.skip_breakdown.worker_alive
    + ', uncommitted=' + summary.skip_breakdown.uncommitted_changes
    + ', git_error=' + summary.skip_breakdown.git_probe_error
    + ', no_registry_gated=' + summary.skip_breakdown.no_registry_gated + ')\n')
  for (const d of decisions) {
    if (d.action === 'skip' && d.reason === 'worker_alive') continue  // quiet the common safe-skip
    process.stdout.write('   - ' + d.action + '  ' + d.dir + '  (' + d.reason + ')\n')
  }
}

if (require.main === module) main()

module.exports = { loadRegistryByTask, gitPorcelain, removeWorktree, LIVE_HEARTBEAT_MS }
