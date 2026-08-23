// doctrine-harvest.test.js - REAL-git proof that a worker's stranded doctrine
// reaches main. Stubbed git would prove nothing here: the whole mechanism is
// plumbing (read-tree / update-index / write-tree / commit-tree / push), so the
// test stands up a throwaway bare origin plus a shared tree, plants a worker
// branch carrying a dummy patterns/*.md exactly the way a dispatched worker
// leaves one behind, runs the harvest, and asserts the file is on origin/main.
//
// Same posture as scheduler-worktree-alloc.test.js: real git, throwaway dirs,
// nothing touches the live repo.
//
// Run with: node tools/doctrine-harvest.test.js   (exit 0 = pass)

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const { harvestDoctrine } = require('./doctrine-harvest')

let passed = 0, failed = 0
function ok (name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}

function git (cwd, args) {
  return execFileSync('git', ['-C', cwd].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t',
      ECODIAOS_BRANCH_OK: '1',
    }),
  })
}

function setup () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctrine-harvest-test-'))
  const origin = path.join(root, 'origin.git')
  const shared = path.join(root, 'shared')

  fs.mkdirSync(origin)
  execFileSync('git', ['init', '--bare', '-b', 'main', origin])

  execFileSync('git', ['clone', origin, shared], { stdio: 'ignore' })
  fs.mkdirSync(path.join(shared, 'patterns', '_archived'), { recursive: true })
  fs.writeFileSync(path.join(shared, 'patterns', 'existing-rule-2026-01-01.md'), '# an existing rule\n')
  fs.writeFileSync(path.join(shared, 'patterns', '_archived', 'old-rule-2025-01-01.md'), '# archived\n')
  git(shared, ['add', '-A'])
  git(shared, ['commit', '-q', '-m', 'base'])
  git(shared, ['push', '-q', 'origin', 'main'])
  git(shared, ['fetch', 'origin', '--quiet'])
  return { root, origin, shared }
}

// Plant a worker branch the way the dispatcher does: a linked worktree off
// origin/main, commits made inside it, worktree still present at harvest time.
function plantWorkerBranch (shared, root, branch, files) {
  const wt = path.join(root, 'wt-' + branch.replace(/\//g, '-'))
  git(shared, ['worktree', 'add', '-B', branch, wt, 'origin/main'])
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(wt, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-q', '-m', 'doctrine: worker authored this and cannot push it'])
  return wt
}

function filesOnMain (shared) {
  git(shared, ['fetch', 'origin', '--quiet'])
  return git(shared, ['ls-tree', '-r', '--name-only', 'origin/main']).split('\n').map((s) => s.trim()).filter(Boolean)
}

async function main () {
  console.log('doctrine-harvest: real-git proof\n')

  // ── 1. the headline case: a worker's new pattern reaches main ──────────────
  {
    const { root, shared } = setup()
    plantWorkerBranch(shared, root, 'worker/row-aaa', {
      'patterns/dummy-harvest-proof-2026-08-23.md': '---\ntriggers: dummy harvest proof\n---\n# dummy harvest proof\n\nA throwaway file planted by the harvest test.\n',
    })

    const before = filesOnMain(shared)
    ok('before: dummy file is NOT on main', !before.includes('patterns/dummy-harvest-proof-2026-08-23.md'))

    const res = await harvestDoctrine({ sharedTree: shared, branch: 'worker/row-aaa', rowId: 'row-aaa' })
    const after = filesOnMain(shared)

    ok('harvest reports ok', res.ok === true, JSON.stringify(res))
    ok('harvest landed exactly the dummy file', res.landed.length === 1 && res.landed[0] === 'patterns/dummy-harvest-proof-2026-08-23.md', JSON.stringify(res.landed))
    ok('AFTER: dummy file IS on origin/main', after.includes('patterns/dummy-harvest-proof-2026-08-23.md'), JSON.stringify(after))
    ok('main advanced by exactly one commit', git(shared, ['rev-list', '--count', 'origin/main']).trim() === '2')

    const landedBody = git(shared, ['show', 'origin/main:patterns/dummy-harvest-proof-2026-08-23.md'])
    ok('landed content is byte-identical to what the worker wrote', landedBody.includes('A throwaway file planted by the harvest test.'))
    fs.rmSync(root, { recursive: true, force: true })
  }

  // ── 2. add-only: never overwrite an existing pattern ──────────────────────
  {
    const { root, shared } = setup()
    plantWorkerBranch(shared, root, 'worker/row-bbb', {
      'patterns/existing-rule-2026-01-01.md': '# HOSTILE REWRITE of a live pattern\n',
    })
    const res = await harvestDoctrine({ sharedTree: shared, branch: 'worker/row-bbb', rowId: 'row-bbb' })
    const body = git(shared, ['show', 'origin/main:patterns/existing-rule-2026-01-01.md'])
    ok('existing pattern is untouched on main', body.trim() === '# an existing rule', body)
    ok('nothing was landed', res.landed.length === 0, JSON.stringify(res))
    ok('main did NOT advance', git(shared, ['rev-list', '--count', 'origin/main']).trim() === '1')
    fs.rmSync(root, { recursive: true, force: true })
  }

  // ── 3. _archived is out of scope ──────────────────────────────────────────
  {
    const { root, shared } = setup()
    plantWorkerBranch(shared, root, 'worker/row-ccc', {
      'patterns/_archived/sneaky-2026-08-23.md': '# should never be harvested\n',
      'src/not-a-pattern.js': 'console.log(1)\n',
    })
    const res = await harvestDoctrine({ sharedTree: shared, branch: 'worker/row-ccc', rowId: 'row-ccc' })
    const after = filesOnMain(shared)
    ok('archived file not landed', !after.includes('patterns/_archived/sneaky-2026-08-23.md'))
    ok('non-pattern source not landed', !after.includes('src/not-a-pattern.js'))
    ok('reports nothing to harvest', res.ok === true && res.landed.length === 0, JSON.stringify(res))
    fs.rmSync(root, { recursive: true, force: true })
  }

  // ── 4. em-dash refusal (character-level ban) ──────────────────────────────
  {
    const { root, shared } = setup()
    plantWorkerBranch(shared, root, 'worker/row-ddd', {
      'patterns/has-em-dash-2026-08-23.md': '# a rule\n\nthis line carries an em dash ' + '\u2014' + ' right here\n',
      'patterns/is-clean-2026-08-23.md': '# a clean rule\n\nno banned characters here\n',
    })
    const res = await harvestDoctrine({ sharedTree: shared, branch: 'worker/row-ddd', rowId: 'row-ddd' })
    const after = filesOnMain(shared)
    ok('em-dash file refused', !after.includes('patterns/has-em-dash-2026-08-23.md'))
    ok('refusal is reported with a reason', res.refused.some((r) => /em-dash/.test(r.reason)), JSON.stringify(res.refused))
    ok('clean sibling still landed', after.includes('patterns/is-clean-2026-08-23.md'), JSON.stringify(after))
    fs.rmSync(root, { recursive: true, force: true })
  }

  // ── 5. clean no-ops ───────────────────────────────────────────────────────
  {
    const { root, shared } = setup()
    const a = await harvestDoctrine({ sharedTree: shared, branch: 'worker/does-not-exist', rowId: 'row-eee' })
    ok('missing branch is a clean no-op, not an error', a.ok === true && /does not exist/.test(a.reason), JSON.stringify(a))

    plantWorkerBranch(shared, root, 'worker/row-fff', { 'README.md': 'no doctrine here\n' })
    const b = await harvestDoctrine({ sharedTree: shared, branch: 'worker/row-fff', rowId: 'row-fff' })
    ok('branch with no patterns is a clean no-op', b.ok === true && b.landed.length === 0, JSON.stringify(b))

    // Re-running the same harvest must be idempotent: the basenames are now on
    // main, so the second pass lands nothing and main does not advance again.
    plantWorkerBranch(shared, root, 'worker/row-ggg', { 'patterns/idem-2026-08-23.md': '# idempotence\n' })
    await harvestDoctrine({ sharedTree: shared, branch: 'worker/row-ggg', rowId: 'row-ggg' })
    const countAfterFirst = git(shared, ['rev-list', '--count', 'origin/main']).trim()
    const second = await harvestDoctrine({ sharedTree: shared, branch: 'worker/row-ggg', rowId: 'row-ggg' })
    ok('re-harvest is idempotent', second.landed.length === 0 && git(shared, ['rev-list', '--count', 'origin/main']).trim() === countAfterFirst, JSON.stringify(second))
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log('\n  ' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
