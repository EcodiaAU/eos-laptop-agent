'use strict'

// doctrine-harvest - land a dispatched worker's NEW pattern files on main before
// the dispatcher prunes its worktree.
//
// THE CAUSE THIS CLOSES
// A dispatched worker commits doctrine to its isolated branch and then cannot
// push it: `git ... push` is denied by worker-capability-ceiling-gate.py, and
// that denial is CORRECT (a worker is the likeliest injection pivot and should
// not hold the conductor's blast radius). So the commit lands on a branch that
// nothing ever integrates, and pruneWorktreeForRow removes the worktree. The
// branch ref survives, but nothing reads it, so the doctrine is invisible to
// knowledge.lookup forever.
//
// Measured on 2026-08-23: 184 distinct pattern files authored off-main and never
// landed across 60 branches. The same method had been codified and lost THREE
// separate times (19532f32, 2fedcfff, 730a6c19), so a cron re-derived it from
// scratch on its third fire. Board row ad25d3fb.
//
// WHY THIS SEAM
// It hooks defaultPruneWorktreeForRow, which is the single funnel every prune
// path already flows through (completion, failure, orphan, stale-lease: five
// call sites). One edit covers all five, and harvest-before-remove is the only
// ordering where the branch is guaranteed to still be readable.
//
// WHY PLUMBING, NOT A CHECKOUT
// Everything below runs through git plumbing against the shared .git directory
// with a TEMP index file. It never checks anything out, never moves HEAD, and
// never writes into a working tree, so it cannot trip the shared tree's
// reference-transaction branch-thrash guard and cannot disturb a live session.
// (Doctrine: branch-thrash-guard-on-shared-tree-2026-06-10.)
//
// SAFETY RAILS (all of them fail CLOSED: harvest nothing rather than harm)
//  - Top-level patterns/*.md only. Never patterns/_archived/ and never any
//    other path, so this can only ever add doctrine.
//  - ADD-ONLY. A basename that already exists anywhere under patterns/ on
//    origin/main is skipped, so an existing pattern can never be overwritten
//    or rewritten by this path.
//  - Em-dashes (U+2014) are banned at character level, so a file carrying one
//    is refused rather than landed.
//  - MAX_FILES caps one harvest; never force-push; the push is a plain
//    fast-forward off the origin/main it was built on, retried once if a
//    concurrent push moved main underneath.
//
// Doctrine: backend/patterns/worker-doctrine-must-be-harvested-at-prune-2026-08-23.md

const { promisify } = require('util')
const { execFile } = require('child_process')
const execFileP = promisify(execFile)
const fs = require('fs')
const os = require('os')
const path = require('path')

const GIT_TIMEOUT_MS = 30_000
// Bound the blast radius of one harvest. A worker legitimately authoring more
// than this many NEW patterns in one arc is a shape worth a human look, so the
// harvest lands the first MAX_FILES and reports the remainder rather than
// silently taking everything.
const MAX_FILES = 25
// Escaped, never a literal: this file is itself subject to the character-level ban.
const EM_DASH = '\u2014'

function auditPath () {
  return process.env.DOCTRINE_HARVEST_LOG ||
    path.join(os.homedir(), '.claude', 'logs', 'ecodia', 'doctrine-harvest.jsonl')
}

function audit (rec) {
  try {
    const p = auditPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(Object.assign({ at: new Date().toISOString() }, rec)) + '\n')
  } catch (_e) { /* audit is best-effort; never block the prune */ }
}

// ── git plumbing helpers ─────────────────────────────────────────────────────

function makeGit (sharedTree) {
  return async function git (args, opts) {
    const env = Object.assign({}, process.env, { ECODIAOS_BRANCH_OK: '1' }, (opts && opts.env) || {})
    const res = await execFileP('git', ['-C', sharedTree].concat(args), {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env,
    })
    return res.stdout
  }
}

// Commits on `branch` that are not reachable from origin/main, oldest first, so
// a file added then superseded on the same branch resolves to its LAST version.
async function commitsOffMain (git, branch) {
  const out = await git(['rev-list', '--reverse', branch, '--not', 'origin/main'])
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

// Top-level patterns/*.md paths ADDED by a commit. diff-filter=A is what makes
// this add-only at the commit level; the basename check below makes it add-only
// against main.
async function addedPatternPaths (git, sha) {
  const out = await git(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', sha, '--', 'patterns/'])
  return out.split('\n')
    .map((s) => s.trim())
    .filter((p) => /^patterns\/[^/]+\.md$/.test(p))
}

async function basenamesOnMain (git) {
  const out = await git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'patterns/'])
  const set = new Set()
  for (const line of out.split('\n')) {
    const p = line.trim()
    if (p.endsWith('.md')) set.add(path.posix.basename(p))
  }
  return set
}

// ── the harvest ──────────────────────────────────────────────────────────────

/**
 * Land a worker branch's NEW top-level pattern files onto origin/main.
 *
 * @param {object} opts
 * @param {string} opts.sharedTree  path to the shared working tree (its .git is the object store)
 * @param {string} opts.branch      the worker branch ref, e.g. worker/<row.id>
 * @param {string} [opts.rowId]     scheduler row id, recorded in the commit trailer
 * @param {boolean} [opts.dryRun]   build the commit but do not push
 * @returns {Promise<object>} { ok, landed[], skipped[], refused[], commit, reason }
 */
async function _harvest (opts) {
  const sharedTree = opts && opts.sharedTree
  const branch = opts && opts.branch
  const rowId = (opts && opts.rowId) || 'unknown'
  const dryRun = !!(opts && opts.dryRun)
  const result = { ok: false, landed: [], skipped: [], refused: [], commit: null, reason: null, rowId, branch }

  if (!sharedTree || !branch) {
    result.reason = 'missing sharedTree or branch'
    return result
  }
  const git = makeGit(sharedTree)

  // The branch must exist. A worktree whose allocation failed has no ref, and
  // that is a clean no-op rather than an error.
  try {
    await git(['rev-parse', '--verify', '--quiet', branch + '^{commit}'])
  } catch (_e) {
    result.ok = true
    result.reason = 'branch does not exist (nothing to harvest)'
    return result
  }

  await git(['fetch', 'origin', 'main', '--quiet']).catch(() => {})

  let shas
  try {
    shas = await commitsOffMain(git, branch)
  } catch (e) {
    result.reason = 'rev-list failed: ' + (e && e.message || e)
    return result
  }
  if (!shas.length) {
    result.ok = true
    result.reason = 'no commits off main'
    return result
  }

  // path -> sha of the LAST commit that added it on this branch.
  const candidates = new Map()
  for (const sha of shas) {
    let paths = []
    try { paths = await addedPatternPaths(git, sha) } catch (_e) { continue }
    for (const p of paths) candidates.set(p, sha)
  }
  if (!candidates.size) {
    result.ok = true
    result.reason = 'no patterns/*.md added on this branch'
    return result
  }

  const onMain = await basenamesOnMain(git)

  // Resolve each candidate to a blob, applying the add-only and em-dash rails.
  const toLand = []
  for (const [p, sha] of candidates) {
    const bn = path.posix.basename(p)
    if (onMain.has(bn)) { result.skipped.push({ path: p, reason: 'basename already on main' }); continue }
    if (toLand.length >= MAX_FILES) { result.skipped.push({ path: p, reason: 'MAX_FILES cap reached' }); continue }
    let blob
    try {
      blob = (await git(['rev-parse', sha + ':' + p])).trim()
    } catch (_e) {
      result.refused.push({ path: p, reason: 'blob not resolvable at ' + sha }); continue
    }
    let body
    try {
      body = await git(['cat-file', 'blob', blob])
    } catch (_e) {
      result.refused.push({ path: p, reason: 'blob unreadable' }); continue
    }
    if (body.includes(EM_DASH)) {
      result.refused.push({ path: p, reason: 'contains a banned em-dash (U+2014)' }); continue
    }
    if (!body.trim()) {
      result.refused.push({ path: p, reason: 'empty file' }); continue
    }
    toLand.push({ path: p, blob, sha, basename: bn })
  }

  if (!toLand.length) {
    result.ok = true
    result.reason = 'nothing new to land'
      return result
  }

  // Build the commit entirely in a temp index, off a pinned origin/main.
  const idxFile = path.join(os.tmpdir(), 'doctrine-harvest-' + process.pid + '-' + Date.now() + '.idx')
  const idxEnv = { GIT_INDEX_FILE: idxFile }
  const pushed = await (async function attemptPush (retry) {
    const base = (await git(['rev-parse', 'origin/main'])).trim()
    await git(['read-tree', base], { env: idxEnv })
    for (const f of toLand) {
      await git(['update-index', '--add', '--cacheinfo', '100644,' + f.blob + ',' + f.path], { env: idxEnv })
    }
    const tree = (await git(['write-tree'], { env: idxEnv })).trim()

    const names = toLand.map((f) => f.basename)
    const subject = 'doctrine(harvest): land ' + names.length + ' pattern file' +
      (names.length === 1 ? '' : 's') + ' from worker branch ' + branch
    const body = [
      'A dispatched worker authored these and could not push them: the worker',
      'capability ceiling denies `git push`, correctly. Harvested from the branch',
      'by the dispatcher at prune time so the doctrine reaches main instead of',
      'dying with the worktree.',
      '',
      'Scheduler row: ' + rowId,
      'Files:',
    ].concat(names.map((n) => '  ' + n)).join('\n')

    const commit = (await git(['commit-tree', tree, '-p', base, '-m', subject, '-m', body])).trim()
    if (dryRun) return { commit, base, pushed: false }
    try {
      await git(['push', 'origin', commit + ':refs/heads/main'])
      return { commit, base, pushed: true }
    } catch (e) {
      // A concurrent push moved main. Re-fetch and rebuild once off the new tip.
      if (retry > 0) {
        await git(['fetch', 'origin', 'main', '--quiet']).catch(() => {})
        return attemptPush(retry - 1)
      }
      throw e
    }
  })(1).catch((e) => ({ error: e && e.message || String(e) }))

  try { fs.unlinkSync(idxFile) } catch (_e) {}

  if (pushed && pushed.error) {
    result.reason = 'push failed: ' + pushed.error
    result.refused = result.refused.concat(toLand.map((f) => ({ path: f.path, reason: 'push failed' })))
      return result
  }

  result.ok = true
  result.commit = pushed.commit
  result.landed = toLand.map((f) => f.path)
  result.reason = dryRun ? 'dry run (commit built, not pushed)' : 'landed on main'
  return result
}

// 2026-08-24 observability fix. Every early return above used to leave the audit
// log silent, so a prune that invoked harvest and legitimately found nothing was
// byte-for-byte indistinguishable from a prune where harvest never ran at all.
// Two live prunes on 2026-08-23 (rows d067c604 and 440536b5) hit `no commits off
// main` and wrote nothing anywhere, which left the whole mechanism unfalsifiable
// from its own telemetry: the only evidence it had fired was the absence of a
// directory. A log that speaks only on success cannot be used to prove liveness,
// which is the same "a check that cannot fail is not a check" shape this module
// was written to close. So the audit moves OUT of the success paths and wraps the
// whole call: one line per invocation, no matter how it ends, throw included.
// Doctrine: backend/patterns/a-harvest-that-logs-only-on-success-cannot-prove-it-ran-2026-08-24.md
async function harvestDoctrine (opts) {
  let result
  try {
    result = await _harvest(opts)
  } catch (e) {
    result = {
      ok: false,
      landed: [],
      skipped: [],
      refused: [],
      commit: null,
      reason: 'threw: ' + (e && e.message || String(e)),
      rowId: (opts && opts.rowId) || 'unknown',
      branch: (opts && opts.branch) || null,
    }
    audit(result)
    throw e
  }
  audit(result)
  return result
}

module.exports = { harvestDoctrine, MAX_FILES }
