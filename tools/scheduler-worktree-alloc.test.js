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

  // 2026-08-30 lane H1: THE RE-DISPATCH DESTRUCTION PATH.
  // `worktree add -B` resets the branch ref to origin/main, so a second dispatch
  // of the same row silently discards every commit the first attempt made. The
  // prune-side harvest never sees it: no prune runs on the way back IN. Row
  // cbade3a0 completed with zero harvest lines and two stranded pattern files,
  // and the dead-row reaper re-arms rows, so this path is live rather than
  // theoretical. Plant a pattern file on the row's branch exactly as a worker
  // leaves one, re-allocate, and assert the file was rescued to the corpus BEFORE
  // -B threw the commit away.
  {
    const patternsDir = path.join(SHARED, 'patterns')
    fs.mkdirSync(patternsDir, { recursive: true })
    // Commit the worker's doctrine inside its own worktree, the way a real one does.
    const rel = 'patterns/rescued-before-the-reset-2026-08-30.md'
    fs.mkdirSync(path.join(wtPath, 'patterns'), { recursive: true })
    fs.writeFileSync(path.join(wtPath, rel), '# rescued before -B reset the ref\n')
    git(wtPath, ['config', 'user.email', 'test@ecodia.au'])
    git(wtPath, ['config', 'user.name', 'wt-alloc-test'])
    git(wtPath, ['add', '-A'])
    git(wtPath, ['commit', '-q', '-m', 'doctrine a re-dispatch would have destroyed'])

    const onBranchBefore = git(SHARED, ['ls-tree', '-r', '--name-only', 'worker/' + ROW_ID]).includes(rel)
    assert(onBranchBefore, 'precondition: the doctrine is on the worker branch and nowhere else')
    assert(!fs.existsSync(path.join(SHARED, rel)), 'precondition: not yet in the corpus on disk')

    // The re-dispatch.
    await scheduler.allocateWorktreeForRow({ id: ROW_ID })

    assert(fs.existsSync(path.join(SHARED, rel)),
      're-dispatch harvests the prior attempt BEFORE -B resets the branch')
    assert(fs.readFileSync(path.join(SHARED, rel), 'utf8') === '# rescued before -B reset the ref\n',
      'the rescued file carries the worker\'s bytes, not a placeholder')
    // The negative that proves the destruction was real: -B did reset the ref, so
    // without the rescue above the commit would now be unreachable from the branch.
    const onBranchAfter = git(SHARED, ['ls-tree', '-r', '--name-only', 'worker/' + ROW_ID]).includes(rel)
    assert(!onBranchAfter, 'control: -B did reset the branch, so the rescue was the only copy')
  }
}

main()
  .then(() => {})
  .catch(e => { console.error('  UNCAUGHT:', e && e.message); failed++ })
  .finally(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_e) {}
    console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed')
    process.exit(failed > 0 ? 1 : 0)
  })
