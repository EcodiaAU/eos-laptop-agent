// scheduler-worktree-alloc.test.js - REAL-git regression test for the worktree
// allocator self-heal (2026-06-20 audit finding a). The main scheduler.test.js
// stubs git, so the exact production failure was never exercised: a directory
// that exists on disk but is NOT a registered worktree makes `git worktree
// remove --force` a silent no-op ("is not a working tree"), `prune` does
// nothing for a present dir, and `git worktree add` then dies "already exists",
// dropping the row to an UNISOLATED shared-tree dispatch. This test stands up a
// throwaway origin + shared tree, plants a non-worktree dir at the row path, and
// asserts allocateWorktreeForRow recovers and registers a clean worktree.
//
// Run with: node tools/scheduler-worktree-alloc.test.js  (exit 0 = pass)

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

let passed = 0, failed = 0
function assert(c, label) { if (c) { console.log('  PASS:', label); passed++ } else { console.error('  FAIL:', label); failed++ } }
function git(cwd, args) { return execFileSync('git', ['-C', cwd].concat(args), { encoding: 'utf8' }) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-alloc-test-'))
const ORIGIN = path.join(TMP, 'origin.git')
const SHARED = path.join(TMP, 'shared')
const WTROOT = path.join(TMP, 'worktrees')
const ROW_ID = '00000000-dead-beef-0000-000000000001'

async function main() {
  // Build a real origin + shared tree with a main branch.
  fs.mkdirSync(ORIGIN, { recursive: true }); execFileSync('git', ['init', '--bare', '-b', 'main', ORIGIN])
  fs.mkdirSync(SHARED, { recursive: true })
  git(SHARED, ['init', '-b', 'main'])
  git(SHARED, ['config', 'user.email', 'test@ecodia.au'])
  git(SHARED, ['config', 'user.name', 'wt-alloc-test'])
  fs.writeFileSync(path.join(SHARED, 'README'), 'seed\n')
  git(SHARED, ['add', '-A']); git(SHARED, ['commit', '-q', '-m', 'seed'])
  git(SHARED, ['remote', 'add', 'origin', ORIGIN]); git(SHARED, ['push', '-q', '-u', 'origin', 'main'])

  // Plant the production failure: a present-but-unregistered directory at the row path.
  const wtPath = path.join(WTROOT, ROW_ID)
  fs.mkdirSync(wtPath, { recursive: true })
  fs.writeFileSync(path.join(wtPath, 'leftover.mjs'), '// orphan checkout artifact\n')
  // Sanity: confirm the pre-fix failure actually reproduces with raw git.
  let rawFailed = false
  try { execFileSync('git', ['-C', SHARED, 'worktree', 'add', '-B', 'worker/' + ROW_ID, wtPath, 'origin/main'], { stdio: 'pipe' }) }
  catch (_e) { rawFailed = true }
  assert(rawFailed, 'raw `git worktree add` over a non-worktree dir fails (reproduces the bug)')

  // Now exercise the real allocator with env pointed at the throwaway repo.
  process.env.SCHEDULER_SHARED_TREE = SHARED
  process.env.SCHEDULER_WORKTREE_ROOT = WTROOT
  const scheduler = require('./scheduler')

  const out = await scheduler.allocateWorktreeForRow({ id: ROW_ID })
  assert(out === wtPath, 'allocateWorktreeForRow returns the worktree path (recovered from pre-existing dir)')
  const list = git(SHARED, ['worktree', 'list', '--porcelain'])
  assert(list.includes(wtPath), 'worktree is now REGISTERED (self-heal succeeded where raw git failed)')
  assert(!fs.existsSync(path.join(wtPath, 'leftover.mjs')), 'stale leftover artifact was cleared')
}

main()
  .then(() => {})
  .catch(e => { console.error('  UNCAUGHT:', e && e.message); failed++ })
  .finally(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_e) {}
    console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed')
    process.exit(failed > 0 ? 1 : 0)
  })
