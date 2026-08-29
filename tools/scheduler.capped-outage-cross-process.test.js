// scheduler.capped-outage-cross-process.test.js - lane D1 verify pass 3, 2026-08-29.
//
// WHAT THIS COVERS THAT THE PASS-2 TEST DOES NOT.
//
// Pass 2 proved the capped-outage latch survives a restart using
// exports._simulateRestart: drop the in-memory state, call loadCappedOutageState
// again, assert the page fires once on the original clock. That is a faithful
// model of the RE-READ, and it is blind to the thing that actually happens on a
// restart, because _simulateRestart is called by a process that has already run
// _setCappedStatePath. The real daemon never does that. Its module-load
// loadCappedOutageState() runs BEFORE any caller can set a path, so it reads
// cappedStatePath()'s default: ~/.ecodiaos/canary-state/scheduler-capped-outage.json.
// A test that redirects the path with the seam therefore exercises a code path
// the daemon does not have, and the one line that matters on a restart (the
// bare loadCappedOutageState() at module scope) is never executed against the
// file under test.
//
// So this file does not use the seam. It overrides HOME, which is what
// os.homedir() reads on POSIX, so the DEFAULT path resolves inside a scratch
// dir. Two real OS processes, a real exit between them, and the second one
// adopts the first one's outage during its own module load with no test seam in
// the path at all.
//
// Four cases, and the last two are the controls that make the first two mean
// something:
//   1. Process A defers once, 11min into an outage on its own clock, and the
//      10min gate has not opened for it yet on defer 1 (firstDeferAt == now).
//      It writes the file and does not page.
//   2. Process A2 (a SEPARATE process, A having exited) defers again. It adopts
//      A's firstDeferAt at module load, computes 11min persisted, and pages
//      EXACTLY once, carrying A's defer count forward (defers == 2).
//   3. CONTROL, fresh HOME: same drive, no state file. persistedMs is 0, so no
//      page. This is what case 2 would look like if adoption did not happen,
//      and it is the only thing that proves case 2's page came from disk.
//   4. CONTROL, stale state: a file whose lastDeferAt is 31min old is DISCARDED,
//      not adopted (CAPPED_OUTAGE_STALE_MS is 30min). A finished outage must not
//      hand its pageSent latch to the next one.
//
// Never texts Tate (_setPagerSender in every child) and never touches Postgres
// (_setPool in every child).
//
// Run: node tools/scheduler.capped-outage-cross-process.test.js   (exit 0 = pass)
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const MIN = 60 * 1000

// ── child mode ───────────────────────────────────────────────────────────────
// argv: --child <t0ms> <nowms>
// HOME is already set by the parent's spawn env, so require() below resolves the
// default state path inside the scratch home and module-load adoption is real.
if (process.argv[2] === '--child') {
  const t0 = Number(process.argv[3])
  const now = Number(process.argv[4])
  const scheduler = require('./scheduler')
  scheduler._setPool({ query: async () => ({ rows: [], rowCount: 0 }) })
  const sent = []
  scheduler._setPagerSender((script, args, done) => { sent.push(args); done(null, 0) })

  const err = new Error('all enabled accounts are capped')
  err.name = 'AllAccountsCappedError'
  err.resets = { 'tate@ecodia.au': new Date(now + 45 * MIN).toISOString() }

  const row = { id: '00000000-0000-0000-0000-0000000000aa', name: 'cowork.crossproc-lane-D1-probe' }

  // adoptedAt module load, captured BEFORE we drive anything
  const adopted = scheduler._getCappedOutageState()

  scheduler.handleAllAccountsCappedDefer(row, err, now).then((page) => {
    process.stdout.write(JSON.stringify({
      t0, now,
      adoptedAtLoad: adopted,
      paged: !!page,
      message: page ? page.message : null,
      stateAfter: scheduler._getCappedOutageState(),
      sends: sent.length,
    }) + '\n')
    process.exit(0)
  }).catch((e) => { process.stderr.write('child error: ' + (e && e.stack || e) + '\n'); process.exit(3) })
  return
}

// ── parent harness ───────────────────────────────────────────────────────────
let failures = 0
function ok (name, fn) {
  try { fn(); console.log('  ok - ' + name) }
  catch (e) { failures++; console.error('  FAIL - ' + name + ': ' + (e && e.message || e)) }
}

function scratchHome (tag) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-xproc-' + tag + '-'))
  return h
}

function statePathFor (home) {
  return path.join(home, '.ecodiaos', 'canary-state', 'scheduler-capped-outage.json')
}

function runChild (home, t0, now) {
  const r = spawnSync(process.execPath, [__filename, '--child', String(t0), String(now)], {
    env: Object.assign({}, process.env, { HOME: home }),
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error('child exited ' + r.status + ' stderr=' + (r.stderr || '').slice(0, 400))
  }
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop()
  return { out: JSON.parse(line), stderr: r.stderr || '' }
}

console.log('scheduler capped-outage latch, ACROSS A REAL PROCESS BOUNDARY\n')

// Anchor the outage 11min in the past on the wall clock so that (a) the 10min
// page gate has opened by the time process A2 runs and (b) lastDeferAt is well
// inside the 30min staleness window, which is what module-load adoption checks.
const NOW = Date.now()
const T0 = NOW - 11 * MIN

const homeMain = scratchHome('main')
let procA = null
let procA2 = null

ok('1. process A writes the state file and does NOT page (its own firstDeferAt is now)', () => {
  assert.strictEqual(fs.existsSync(statePathFor(homeMain)), false, 'scratch home should start with no state file')
  procA = runChild(homeMain, T0, T0)
  assert.deepStrictEqual(procA.out.adoptedAtLoad, { firstDeferAt: null, defers: 0, sent: false },
    'process A must adopt nothing at load: ' + JSON.stringify(procA.out.adoptedAtLoad))
  assert.strictEqual(procA.out.paged, false, 'defer 1 at persistedMs=0 must not page')
  assert.strictEqual(procA.out.sends, 0, 'process A must send nothing')
  assert.ok(fs.existsSync(statePathFor(homeMain)), 'process A must have written ' + statePathFor(homeMain))
  const st = JSON.parse(fs.readFileSync(statePathFor(homeMain), 'utf8'))
  assert.strictEqual(st.firstDeferAt, T0, 'persisted firstDeferAt must be A clock T0')
  assert.strictEqual(st.defers, 1, 'persisted defers must be 1')
  assert.strictEqual(st.pageSent, false, 'persisted pageSent must be false')
})

ok('2. process A2, a SEPARATE process, adopts at module load and pages once on A clock', () => {
  procA2 = runChild(homeMain, T0, NOW)
  assert.strictEqual(procA2.out.adoptedAtLoad.firstDeferAt, T0,
    'A2 must adopt A firstDeferAt at MODULE LOAD, got ' + JSON.stringify(procA2.out.adoptedAtLoad))
  assert.strictEqual(procA2.out.adoptedAtLoad.defers, 1, 'A2 must adopt A defer count')
  assert.strictEqual(procA2.out.adoptedAtLoad.sent, false, 'A had not paged, so A2 must not think it had')
  assert.ok(/adopted an in-progress capped outage from disk/.test(procA2.stderr),
    'A2 stderr must record the adoption, got: ' + procA2.stderr.slice(0, 300))
  assert.strictEqual(procA2.out.paged, true, 'A2 must page: 11min persisted on A clock is past the 10min gate')
  assert.strictEqual(procA2.out.sends, 1, 'A2 must send exactly one page')
  assert.strictEqual(procA2.out.stateAfter.defers, 2, 'defer count must carry across the process boundary')
  assert.ok(/deferred 2 times over ~11min/.test(procA2.out.message),
    'page must quote A count and A elapsed, got: ' + procA2.out.message)
  const st = JSON.parse(fs.readFileSync(statePathFor(homeMain), 'utf8'))
  assert.strictEqual(st.pageSent, true, 'the latch must be mirrored to disk so a THIRD process does not re-page')
})

ok('3. CONTROL fresh home: same drive with no state file does NOT page', () => {
  const homeFresh = scratchHome('fresh')
  const r = runChild(homeFresh, T0, NOW)
  assert.deepStrictEqual(r.out.adoptedAtLoad, { firstDeferAt: null, defers: 0, sent: false },
    'nothing to adopt in a fresh home')
  assert.strictEqual(r.out.paged, false,
    'without adoption persistedMs is 0 and the gate is shut; case 2 page therefore came from disk')
  assert.strictEqual(r.out.sends, 0, 'control must send nothing')
})

ok('4. CONTROL stale file: an outage last deferred 31min ago is discarded, not adopted', () => {
  const homeStale = scratchHome('stale')
  const p = statePathFor(homeStale)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({
    firstDeferAt: NOW - 90 * MIN,
    defers: 40,
    pageSent: true,            // a finished outage's latch. Adopting it would SILENCE the next outage.
    lastDeferAt: NOW - 31 * MIN,
  }))
  const r = runChild(homeStale, T0, NOW)
  assert.deepStrictEqual(r.out.adoptedAtLoad, { firstDeferAt: null, defers: 0, sent: false },
    'a 31min-stale outage must be discarded at load, got ' + JSON.stringify(r.out.adoptedAtLoad))
  assert.ok(!/adopted an in-progress capped outage/.test(r.stderr),
    'stale state must not log an adoption')
  assert.strictEqual(r.out.paged, false, 'discarded state means a fresh clock, so no page on defer 1')
  const st = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.strictEqual(st.pageSent, false, 'the stale pageSent=true must have been overwritten, not inherited')
  assert.strictEqual(st.defers, 1, 'the stale defer count must not carry into the new outage')
})

ok('5. the temp-and-rename persist leaks no scratch file and always commits whole JSON', () => {
  // HONEST SCOPE. This asserts the INVARIANTS of the temp-and-rename write: no
  // .tmp.<pid> is left behind, exactly one file exists, and the committed bytes
  // parse. It does NOT prove atomicity, and it passes against the old bare
  // writeFileSync too, because a write that SUCCEEDS looks identical either way.
  // The atomicity claim rests on rename(2) being atomic within a filesystem, not
  // on this test: forcing a genuine torn write needs a full disk or a kill landed
  // inside the write syscall, and a probabilistic race test here would be flaky
  // without being more convincing. What IS tested is the consequence that matters
  // when the write fails anyway, in case 6.
  const home = scratchHome('atomic')
  runChild(home, T0, T0)
  const dir = path.dirname(statePathFor(home))
  const left = fs.readdirSync(dir).filter(f => f.includes('.tmp.'))
  assert.deepStrictEqual(left, [], 'a scratch file was left behind in ' + dir + ': ' + left.join(', '))
  assert.deepStrictEqual(fs.readdirSync(dir), ['scheduler-capped-outage.json'],
    'exactly one file should exist after a persist')
  // The committed state must always be whole, which is what rename buys.
  JSON.parse(fs.readFileSync(statePathFor(home), 'utf8'))
})

ok('6. a torn file from BEFORE this fix still degrades to in-memory, it does not throw', () => {
  const home = scratchHome('torn')
  const p = statePathFor(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '{"firstDeferAt":178799')   // cut off mid-number, as a full disk leaves it
  const r = runChild(home, T0, NOW)
  assert.deepStrictEqual(r.out.adoptedAtLoad, { firstDeferAt: null, defers: 0, sent: false },
    'a corrupt file must adopt nothing rather than crash the dispatcher')
  assert.strictEqual(r.out.paged, false, 'nothing adopted means a fresh clock, so no page on defer 1')
  const st = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.strictEqual(st.defers, 1, 'the torn file must be replaced by a whole one on the next persist')
})

console.log('')
if (failures) { console.error(failures + ' FAILED'); process.exit(1) }
console.log('ALL PASS')
