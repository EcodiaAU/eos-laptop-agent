'use strict'

// doctrine-harvest - land a dispatched worker's NEW pattern files in the
// conductor's doctrine corpus before the dispatcher prunes its worktree.
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
// WHERE IT LANDS, AND WHY THAT IS THE WHOLE POINT (revised 2026-08-27)
// It writes the file into the conductor's working tree on disk. It does NOT
// publish to origin/main, and the first version of this module did, which
// recreated the very failure it was built to close.
//
// knowledge-index/indexer.js reads the corpus from DISK: BACKEND is
// path.resolve(__dirname, '..') and ROOTS[0] is path.join(BACKEND, 'patterns'),
// walked with fs and keyed on mtime. It never resolves a git ref. So a file that
// exists only on origin/main is unreachable by knowledge.lookup, which is the
// single reader this mechanism exists to serve. Measured 2026-08-27: nothing on
// any schedule brings origin/main back into the conductor tree. There is no
// launchd puller, no scheduler row, and no git hook. The only reconvergence is a
// conductor session running `git merge origin/main` by hand, seven times in
// main's 242-entry reflog and every one of them inside the four days this module
// has been publishing. Doctrine moved from "stranded on a worker branch" to
// "stranded on origin/main", and stayed invisible either way until a human
// happened to notice.
//
// Writing to disk instead puts worker doctrine in the same durability lane every
// conductor-authored pattern already uses, which is the lane that demonstrably
// works: corpus-snapshot-committer commits patterns/ locally within 6h,
// precious-work-backup carries those commits off-disk, and the conductor pushes
// on its own cadence. It is also how the 17 files rescued on 2026-08-23 landed.
// Nothing new has to be built or scheduled for this to be durable.
//
// WHY A PLAIN WRITE CANNOT DISTURB THE SHARED TREE
// A plain fs write touches no ref, no index, and no HEAD, so the shared tree's
// reference-transaction branch-thrash guard is structurally unreachable from
// here: that guard only rejects updates to HEAD or to HEAD's target ref, and a
// file write performs neither. This is strictly safer than the old plumbing
// path, which at least wrote a temp index and pushed a ref. Only ref flips
// endanger a live session; an untracked file appearing under patterns/ does not.
// (Doctrine: branch-thrash-guard-on-shared-tree-2026-06-10.)
//
// SAFETY RAILS (all of them fail CLOSED: harvest nothing rather than harm)
//  - Top-level patterns/*.md only. Never patterns/_archived/ and never any
//    other path, so this can only ever add doctrine.
//  - ADD-ONLY, enforced by the filesystem. The write uses the 'wx' flag, an
//    atomic exclusive create that fails if the path exists, so an existing
//    pattern can never be overwritten even by two harvests racing on the same
//    basename. The pre-check below (disk basenames, including _archived/, unioned
//    with origin/main) reports the skip with a reason; 'wx' is what guarantees it.
//  - Em-dashes (U+2014) are banned at character level, so a file carrying one
//    is refused rather than landed.
//  - MAX_FILES caps one harvest. A partial batch is reported honestly: files
//    written before a mid-batch failure stay written and stay in landed[].
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

// Stamped on EVERY audit line, no matter how the call ends. require() caches this
// module, so a fix here is inert until the laptop-agent restarts, and the only way
// the 2026-08-27 fix could be proven loaded was a reason-string flip that appears
// only when something lands. A prune that lands nothing is the common case, so
// that proof was unavailable most of the time. Bump this string with any change
// whose liveness a later session has to establish from the log alone.
const BUILD = 'toplevel-baseline-2026-08-30'
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

// Every pattern basename the corpus ALREADY holds, from both surfaces, because
// they disagree and add-only has to hold against the union of them.
//
// DISK is the one that decides whether a write can succeed, and it is the one
// knowledge.lookup reads, so it is the primary. origin/main is unioned in as a
// second rail: a basename published there but not yet merged down would
// otherwise be written to disk as a divergent second copy of the same doctrine,
// and the next `git merge origin/main` would land it as a conflict. Skipping it
// leaves a real gap (that pattern is unreachable by lookup until someone merges),
// but that gap is doctrine-branch-drift-canary's job to surface, not this one's
// to paper over by duplicating the file.
//
// The baseline splits in two, and the split is the whole point.
//
// LIVE is patterns/*.md at the TOP LEVEL, which is the only depth knowledge-index
// actually indexes and the only depth harvest ever writes to. A live basename
// blocks: landing over it would put a divergent second copy of the same doctrine
// in front of every reader.
//
// ARCHIVED is the same basename sitting under a subdirectory, patterns/_archived/
// in practice. It used to block too, and that was wrong. 2026-08-30: row 102b5849
// deliberately restored never-cdp-drive-live-client-editor-with-autosave-2026-07-16
// (status active, severity HIGH, the rule that stops a CDP probe mutating a
// client's live editor) out of _archived. Harvest ran ten minutes later, matched
// the ARCHIVED copy, and skipped it as 'basename already in the corpus'. The file
// reached neither disk nor origin/main, and knowledge.lookup could not return it.
//
// The old block was aimed at a stale branch resurrecting superseded doctrine. It
// cannot tell that apart from a deliberate un-archival, and the two errors are not
// symmetric. A wrongly-resurrected pattern is VISIBLE in the corpus and re-archived
// in one move. A wrongly-refused un-archival is INVISIBLE and permanent, because
// nothing ever retries a harvest: the branch is pruned seconds later. So an
// archived basename no longer blocks, and every such landing is announced in
// result.unarchived so the conductor can reverse it if the judgement was wrong.
function basenamesOnDisk (sharedTree) {
  const live = new Set()
  const archived = new Set()
  const root = path.join(sharedTree, 'patterns')
  const walk = (dir, depth) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_e) { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.md')) (depth === 0 ? live : archived).add(e.name)
    }
  }
  walk(root, 0)
  return { live, archived }
}

// Same split on the origin/main leg. This half is easy to forget and fixing only
// the disk half leaves the bug alive: `ls-tree -r` walks every depth, so a copy
// archived ON ORIGIN/MAIN poisoned the baseline exactly like the disk copy did.
async function basenamesOnMain (git) {
  const out = await git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'patterns/'])
  const live = new Set()
  const archived = new Set()
  for (const line of out.split('\n')) {
    const p = line.trim()
    if (!p.endsWith('.md')) continue
    const rest = p.startsWith('patterns/') ? p.slice('patterns/'.length) : p
    ;(rest.includes('/') ? archived : live).add(path.posix.basename(p))
  }
  return { live, archived }
}

// The union, kept split. A failure to read origin/main is NOT fatal (the disk rail
// plus the 'wx' exclusive create still hold add-only), but it must not silently
// widen what harvest is willing to write, so it degrades to disk-only and says so.
async function existingBasenames (git, sharedTree) {
  const { live, archived } = basenamesOnDisk(sharedTree)
  let degraded = false
  try {
    const m = await basenamesOnMain(git)
    for (const bn of m.live) live.add(bn)
    for (const bn of m.archived) archived.add(bn)
  } catch (_e) { degraded = true }
  // A basename that is live SOMEWHERE outranks the same basename archived
  // elsewhere: live blocks, and being archived on the other leg cannot unblock it.
  for (const bn of live) archived.delete(bn)
  return { set: live, archived, degraded }
}

// ── the harvest ──────────────────────────────────────────────────────────────

/**
 * Land a worker branch's NEW top-level pattern files in the conductor's corpus
 * on disk, where knowledge.lookup reads.
 *
 * @param {object} opts
 * @param {string} opts.sharedTree  the conductor working tree: BOTH the git object
 *                                  store the branch is read from AND the corpus
 *                                  written to
 * @param {string} opts.branch      the worker branch ref, e.g. worker/<row.id>
 * @param {string} [opts.rowId]     scheduler row id, recorded in the audit line
 * @param {boolean} [opts.dryRun]   resolve and vet the files but write nothing
 * @returns {Promise<object>} { ok, landed[], skipped[], refused[], commit, reason }
 *                            commit is always null now: nothing is committed here,
 *                            corpus-snapshot-committer does that within 6h. The key
 *                            is kept so existing audit-log readers do not break.
 */
async function _harvest (opts) {
  const sharedTree = opts && opts.sharedTree
  const branch = opts && opts.branch
  const rowId = (opts && opts.rowId) || 'unknown'
  const dryRun = !!(opts && opts.dryRun)
  const result = { ok: false, landed: [], skipped: [], refused: [], unarchived: [], commit: null, reason: null, rowId, branch, build: BUILD }

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

  const existing = await existingBasenames(git, sharedTree)
  if (existing.degraded) result.degraded = 'could not read origin/main basenames; add-only fell back to disk plus the exclusive create'

  // Resolve each candidate to a blob, applying the add-only and em-dash rails.
  const toLand = []
  for (const [p, sha] of candidates) {
    const bn = path.posix.basename(p)
    if (existing.set.has(bn)) { result.skipped.push({ path: p, reason: 'basename already in the corpus' }); continue }
    // Not a block. Recorded so the landing is reviewable rather than silent.
    if (existing.archived.has(bn)) result.unarchived.push(bn)
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
    // body is carried, not re-read at write time: it is the exact bytes already
    // vetted against the em-dash ban and the empty-file rail. Re-reading the blob
    // later would let a vetted file and a written file drift apart.
    toLand.push({ path: p, blob, sha, basename: bn, body })
  }

  if (!toLand.length) {
    result.ok = true
    result.reason = 'nothing new to land'
      return result
  }

  if (dryRun) {
    result.ok = true
    result.landed = toLand.map((f) => f.path)
    result.reason = 'dry run (files vetted, nothing written)'
    return result
  }

  // Write each vetted file into the conductor's corpus.
  //
  // 'wx' is an atomic exclusive create: it fails with EEXIST rather than
  // truncating. That is what actually enforces add-only, and it is why two
  // harvests racing on the same basename cannot corrupt a pattern. The
  // basename pre-check above is the fast path that reports a readable reason;
  // this flag is the guarantee. The old publish path had no equivalent, and the
  // audit log shows the race it allowed: row d85e97cd landed the same three
  // files twice, commits 995a6658 and 1718914339, eight seconds apart.
  //
  // A mid-batch failure is reported honestly rather than rolled back. Files
  // already written are real doctrine that is already readable, so removing
  // them to make the result tidy would destroy the exact thing this exists to
  // save. landed[] carries what is on disk; refused[] carries the rest.
  const patternsDir = path.join(sharedTree, 'patterns')
  try {
    fs.mkdirSync(patternsDir, { recursive: true })
  } catch (e) {
    result.reason = 'patterns dir unusable: ' + (e && e.message || e)
    result.refused = result.refused.concat(toLand.map((f) => ({ path: f.path, reason: 'patterns dir unusable' })))
    return result
  }

  for (const f of toLand) {
    const dest = path.join(patternsDir, f.basename)
    try {
      fs.writeFileSync(dest, f.body, { encoding: 'utf8', flag: 'wx' })
      result.landed.push(f.path)
    } catch (e) {
      const code = e && e.code
      if (code === 'EEXIST') {
        // Lost a race, or the pre-check read a stale directory. Either way the
        // corpus already holds this basename and add-only held.
        result.skipped.push({ path: f.path, reason: 'basename appeared in the corpus before the write' })
      } else {
        result.refused.push({ path: f.path, reason: 'write failed: ' + (code || (e && e.message) || e) })
      }
    }
  }

  result.ok = true
  result.commit = null
  // The un-archival variant is a DISTINCT reason string on purpose: it is the one
  // landing a human should look at, and burying it inside the ordinary success
  // line is how the old refusal stayed invisible for as long as it did.
  result.reason = result.landed.length
    ? (result.unarchived.length
      ? 'written to the conductor corpus on disk (un-archived ' + result.unarchived.length + ')'
      : 'written to the conductor corpus on disk')
    : 'nothing new to land'
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
      unarchived: [],
      commit: null,
      reason: 'threw: ' + (e && e.message || String(e)),
      build: BUILD,
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
