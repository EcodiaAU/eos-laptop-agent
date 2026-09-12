// scheduler-worktree-dotgit-guard.test.js - regression test for the 2026-09-13
// lane W1 boot-time .git assertion on the dispatched-worker path.
//
// THE DEFECT. A worktree directory with no .git entry is handed to a worker, the
// worker writes files into it, and nothing errors. There is no repository, so
// there is no commit, no push, and no worker branch for the prune-path
// doctrine-harvest to read. The output is unreachable by construction. Measured
// 2026-09-13 over _worktrees/dispatched: 2 of 28 directories, both from June
// 2026, each holding real orphaned worker output (a novel Supabase RLS migration
// in one, a 272-file src/ tree in the other). The worktree sweeper deliberately
// PRESERVES unregistered directories, so nothing ever reclaimed them.
//
// WHY THE GUARD IS IN THE EXPORTED WRAPPER. _setWorktreeFns lets any caller
// inject an allocator. A check inside defaultAllocateWorktreeForRow is not on the
// path an injected allocator takes, so the wrapper is the only placement that
// covers every dispatch. These cases drive exactly that seam.
//
// Run with: node tools/scheduler-worktree-dotgit-guard.test.js  (exit 0 = pass)

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

let passed = 0, failed = 0
function assert(c, label) { if (c) { console.log('  PASS:', label); passed++ } else { console.error('  FAIL:', label); failed++ } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-dotgit-guard-'))

// The env must be pointed somewhere harmless BEFORE require: scheduler.js reads
// SHARED_TREE / WORKTREE_ROOT at module load. Every case below injects its own
// allocator, so no real git ever runs.
process.env.SCHEDULER_SHARED_TREE = path.join(TMP, 'shared')
process.env.SCHEDULER_WORKTREE_ROOT = path.join(TMP, 'worktrees')
fs.mkdirSync(process.env.SCHEDULER_SHARED_TREE, { recursive: true })
fs.mkdirSync(process.env.SCHEDULER_WORKTREE_ROOT, { recursive: true })

const scheduler = require('./scheduler')

async function main() {
  // ── CASE 1: the defect. A directory with worker output and no .git. ────────
  // This is the fossil shape reproduced exactly: files present, repository absent.
  const orphanDir = path.join(TMP, 'worktrees', 'row-with-no-git')
  fs.mkdirSync(orphanDir, { recursive: true })
  fs.writeFileSync(path.join(orphanDir, 'q.py'), '# worker output that could never leave\n')

  scheduler._setWorktreeFns({ allocate: async () => orphanDir })
  let threw = null
  try { await scheduler.allocateWorktreeForRow({ id: 'row-with-no-git' }) }
  catch (e) { threw = e }

  assert(threw !== null,
    'a worktree with no .git is REFUSED (the allocation throws instead of returning it)')
  assert(threw !== null && String(threw.message).includes(orphanDir),
    'the failure NAMES the offending directory, so it is recoverable rather than silent')
  assert(fs.existsSync(path.join(orphanDir, 'q.py')),
    'the guard preserves the directory as evidence rather than deleting the only copy')

  // ── CASE 2: the control that proves the guard discriminates. ───────────────
  // `.git` in a LINKED worktree is a regular FILE holding a gitdir: pointer, not
  // a directory. If the guard ever tested isDirectory(), this case goes red while
  // case 1 still passes, which is the inverted guard that reads as working.
  const goodDir = path.join(TMP, 'worktrees', 'row-with-git-file')
  fs.mkdirSync(goodDir, { recursive: true })
  fs.writeFileSync(path.join(goodDir, '.git'), 'gitdir: /somewhere/.git/worktrees/row-with-git-file\n')

  scheduler._setWorktreeFns({ allocate: async () => goodDir })
  let good = null, goodErr = null
  try { good = await scheduler.allocateWorktreeForRow({ id: 'row-with-git-file' }) }
  catch (e) { goodErr = e }

  assert(goodErr === null && good === goodDir,
    'control: a worktree whose .git is a FILE (the real linked-worktree shape) passes through')

  // ── CASE 3: the second control. A .git DIRECTORY also passes. ──────────────
  // Not the dispatched shape, but a non-linked clone is a legitimate repository
  // and must not be refused.
  const cloneDir = path.join(TMP, 'worktrees', 'row-with-git-dir')
  fs.mkdirSync(path.join(cloneDir, '.git'), { recursive: true })

  scheduler._setWorktreeFns({ allocate: async () => cloneDir })
  let clone = null, cloneErr = null
  try { clone = await scheduler.allocateWorktreeForRow({ id: 'row-with-git-dir' }) }
  catch (e) { cloneErr = e }

  assert(cloneErr === null && clone === cloneDir,
    'control: a worktree whose .git is a DIRECTORY passes through')

  // ── CASE 4: a null allocation is UNCHANGED behaviour. ──────────────────────
  // dispatchOne already treats a missing worktree path as the loud no-isolation
  // fallback. The guard must not convert that into a throw, or every allocation
  // failure becomes a dispatch failure.
  scheduler._setWorktreeFns({ allocate: async () => null })
  let nullOut = 'unset', nullErr = null
  try { nullOut = await scheduler.allocateWorktreeForRow({ id: 'row-with-no-path' }) }
  catch (e) { nullErr = e }

  assert(nullErr === null && !nullOut,
    'control: a null allocation still flows through as the existing no-worktree dispatch')

  scheduler._resetWorktreeFns()
}

main()
  .then(() => {})
  .catch(e => { console.error('  UNCAUGHT:', e && e.message); failed++ })
  .finally(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_e) {}
    console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed')
    process.exit(failed > 0 ? 1 : 0)
  })
