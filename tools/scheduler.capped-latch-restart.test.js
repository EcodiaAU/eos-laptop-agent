#!/usr/bin/env node
// Does the capped-outage pager latch survive a REAL process boundary?
//
// The latch and its clock live on disk because a cap is exactly what restarts
// the daemon: the cap fires account-switch.sh and wakes the watchdogs, so the
// outage that most needs one page is the outage most likely to lose its
// in-memory state. scheduler.capped-outage-durability.test.js proves the shape
// in ONE process through the _simulateRestart seam, which drops the in-memory
// latch and re-reads the file. This test removes the seam and uses two real
// node processes, because the seam is the thing standing in for the boundary.
//
// A correction to the brief that asked for this. The brief prescribed pointing
// the second process at a scratch path with _setCappedStatePath. That cannot
// exercise what it is trying to exercise: loadCappedOutageState() runs at MODULE
// LOAD (the bare call under its definition), and _setCappedStatePath is only
// reachable AFTER require returns, so a scratch path set that way is never the
// path the adoption read. The adoption resolves through os.homedir(), which on
// POSIX honours $HOME, so the only way to redirect the module-load read is to
// give the child a scratch HOME. That is what this does, and it is also why the
// live ~/.ecodiaos/canary-state file is asserted untouched at the end.
//
// Run: node tools/scheduler.capped-latch-restart.test.js
// Failing-first control: SCHED_PATH=/tmp/pristine-c9e82bb-scheduler.js node ...
//   (pass 1's file has the pager but no persistence; every adoption leg fails.)

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const SCHED_PATH = process.env.SCHED_PATH || path.join(__dirname, 'scheduler.js')
const STATE_REL = path.join('.ecodiaos', 'canary-state', 'scheduler-capped-outage.json')
const ELEVEN_MIN = 11 * 60 * 1000

let pass = 0, fail = 0
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n        ' + detail : '')) }
}

// ── the child ────────────────────────────────────────────────────────────────
// Runs in its own process with its own HOME. Requires the scheduler (which
// adopts from disk at module load), injects the pool + pager seams, drives the
// REAL capped-defer arm at the caller's clock, and prints one JSON line.
const CHILD = `
const S = require(process.env.SCHED_PATH)
const T = Number(process.env.DRIVE_AT)
const AGAIN = process.env.DRIVE_AGAIN_AT ? Number(process.env.DRIVE_AGAIN_AT) : null
const adopted = S._getCappedOutageState()          // read BEFORE any seam runs
const queries = []
S._setPool({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 } } })
const sends = []
S._setPagerSender((script, args, cb) => { sends.push({ script, args }); cb(null, 0) })
const err = { resets: { 'tate@ecodia.au': new Date(T + 3600000).toISOString() } }
;(async () => {
  const r1 = await S.handleAllAccountsCappedDefer({ id: 'row-' + process.env.ROLE }, err, T)
  let r2 = null
  if (AGAIN !== null) r2 = await S.handleAllAccountsCappedDefer({ id: 'row-' + process.env.ROLE + '-2' }, err, AGAIN)
  process.stdout.write('RESULT ' + JSON.stringify({
    role: process.env.ROLE,
    adoptedAtLoad: adopted,
    paged1: r1 !== null, paged2: r2 !== null,
    msg1: r1 && r1.message, msg2: r2 && r2.message,
    sendCount: sends.length,
    queryCount: queries.length,
    state: S._getCappedOutageState(),
  }) + '\\n')
  process.exit(0)
})()
`

function runChild (role, home, driveAt, driveAgainAt) {
  const r = spawnSync(process.execPath, ['-e', CHILD], {
    env: Object.assign({}, process.env, {
      HOME: home,
      ROLE: role,
      SCHED_PATH: SCHED_PATH,
      DRIVE_AT: String(driveAt),
      DRIVE_AGAIN_AT: driveAgainAt ? String(driveAgainAt) : '',
      DATABASE_URL: '',           // must never be reached: the pool is injected
    }),
    encoding: 'utf8',
    timeout: 60000,
  })
  const line = String(r.stdout || '').split('\n').find(l => l.startsWith('RESULT '))
  return {
    exit: r.status,
    stderr: String(r.stderr || ''),
    stdout: String(r.stdout || ''),
    json: line ? JSON.parse(line.slice(7)) : null,
  }
}

function readState (home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, STATE_REL), 'utf8')) } catch (e) { return null }
}

// ── the drive ────────────────────────────────────────────────────────────────
console.log('capped-latch across a REAL process boundary  (scheduler: ' + SCHED_PATH + ')')

const liveStatePath = path.join(os.homedir(), STATE_REL)
const liveExistedBefore = fs.existsSync(liveStatePath)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capped-latch-'))
const T0 = Date.now()   // REAL now: process B's module-load staleness gate compares against real Date.now()

console.log('\n[1] process A: first capped defer, no page yet, state on disk')
const a = runChild('A', home, T0)
ok('A exited 0', a.exit === 0, 'exit=' + a.exit + ' stderr=' + a.stderr.slice(0, 300))
ok('A did not page (0min < 10min gate)', a.json && a.json.paged1 === false && a.json.sendCount === 0,
  JSON.stringify(a.json))
ok('A adopted nothing at load (no prior file)', a.json && a.json.adoptedAtLoad.firstDeferAt === null,
  JSON.stringify(a.json && a.json.adoptedAtLoad))
ok('A ran the real defer UPDATE against the injected pool', a.json && a.json.queryCount === 1)
const stateA = readState(home)
ok('A wrote the state file', stateA !== null, 'path=' + path.join(home, STATE_REL))
ok('A file carries firstDeferAt === T0', stateA && stateA.firstDeferAt === T0, JSON.stringify(stateA))
ok('A file carries defers=1 pageSent=false', stateA && stateA.defers === 1 && stateA.pageSent === false,
  JSON.stringify(stateA))

console.log('\n[2] process B: a genuinely new process adopts A\'s clock at module load and pages ONCE')
const b = runChild('B', home, T0 + ELEVEN_MIN, T0 + ELEVEN_MIN + 60000)
ok('B exited 0', b.exit === 0, 'exit=' + b.exit + ' stderr=' + b.stderr.slice(0, 300))
ok('B logged the adoption at module load', b.stderr.includes('adopted an in-progress capped outage from disk') &&
  b.stderr.includes(new Date(T0).toISOString()), b.stderr.slice(0, 400))
ok('B adopted A\'s firstDeferAt BEFORE any seam was injected',
  b.json && b.json.adoptedAtLoad.firstDeferAt === T0, JSON.stringify(b.json && b.json.adoptedAtLoad))
ok('B paged exactly once', b.json && b.json.paged1 === true && b.json.sendCount === 1, JSON.stringify(b.json))
ok('B page measured the outage on A\'s clock (~11min, not 0)',
  b.json && /over ~11min/.test(String(b.json.msg1)), String(b.json && b.json.msg1).slice(0, 200))
ok('B page names the count across BOTH processes (2 defers)',
  b.json && /deferred 2 times/.test(String(b.json.msg1)), String(b.json && b.json.msg1).slice(0, 200))
ok('B latch holds: the second defer a minute later does not page again',
  b.json && b.json.paged2 === false && b.json.sendCount === 1, JSON.stringify(b.json))
const stateB = readState(home)
ok('B mirrored pageSent=true to disk with A\'s firstDeferAt',
  stateB && stateB.pageSent === true && stateB.firstDeferAt === T0, JSON.stringify(stateB))

console.log('\n[3] CONTROL: a fresh HOME with no file must NOT page at the same clock')
const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'capped-latch-ctl-'))
const c = runChild('C', homeC, T0 + ELEVEN_MIN)
ok('C exited 0', c.exit === 0, 'exit=' + c.exit + ' stderr=' + c.stderr.slice(0, 300))
ok('C did NOT page, so B\'s page came from the adopted file and nothing else',
  c.json && c.json.paged1 === false && c.json.sendCount === 0, JSON.stringify(c.json))

console.log('\n[4] CONTROL: a STALE outage on disk (>30min) is discarded, not adopted')
const homeD = fs.mkdtempSync(path.join(os.tmpdir(), 'capped-latch-stale-'))
fs.mkdirSync(path.dirname(path.join(homeD, STATE_REL)), { recursive: true })
const staleFirst = T0 - (90 * 60 * 1000)
fs.writeFileSync(path.join(homeD, STATE_REL), JSON.stringify({
  firstDeferAt: staleFirst, defers: 9, pageSent: true, lastDeferAt: T0 - (31 * 60 * 1000),
}))
const d = runChild('D', homeD, T0)
ok('D exited 0', d.exit === 0, 'exit=' + d.exit + ' stderr=' + d.stderr.slice(0, 300))
ok('D refused the stale outage at load', d.json && d.json.adoptedAtLoad.firstDeferAt === null,
  JSON.stringify(d.json && d.json.adoptedAtLoad))
ok('D did not inherit the stale pageSent (which would SILENCE this outage)',
  d.json && d.json.adoptedAtLoad.sent === false && d.json.state.firstDeferAt === T0,
  JSON.stringify(d.json && d.json.state))

console.log('\n[5] a recovered dispatch DELETES the file, so the next outage pages afresh')
const homeE = fs.mkdtempSync(path.join(os.tmpdir(), 'capped-latch-recover-'))
const RECOVER = `
const S = require(process.env.SCHED_PATH)
const fs = require('fs'), path = require('path')
const SP = path.join(process.env.HOME, '.ecodiaos', 'canary-state', 'scheduler-capped-outage.json')
S._setPool({ query: async () => ({ rows: [], rowCount: 1 }) })
S._setPagerSender((s, a, cb) => cb(null, 0))
;(async () => {
  await S.handleAllAccountsCappedDefer({ id: 'r' }, { resets: {} }, Number(process.env.DRIVE_AT))
  const existed = fs.existsSync(SP)
  S.noteSuccessfulDispatch()
  const after = fs.existsSync(SP)
  process.stdout.write('RESULT ' + JSON.stringify({ existed, after }) + '\\n')
  process.exit(0)
})()
`
const e = spawnSync(process.execPath, ['-e', RECOVER], {
  env: Object.assign({}, process.env, { HOME: homeE, SCHED_PATH, DRIVE_AT: String(T0), DATABASE_URL: '' }),
  encoding: 'utf8', timeout: 60000,
})
const eLine = String(e.stdout || '').split('\n').find(l => l.startsWith('RESULT '))
const eJson = eLine ? JSON.parse(eLine.slice(7)) : null
ok('E exited 0', e.status === 0, 'exit=' + e.status + ' stderr=' + String(e.stderr).slice(0, 300))
ok('E wrote the file on defer then DELETED it on recovery',
  eJson && eJson.existed === true && eJson.after === false, JSON.stringify(eJson))

console.log('\n[6] isolation: the LIVE state path was never touched by this test')
ok('live ~/.ecodiaos/canary-state/scheduler-capped-outage.json unchanged',
  fs.existsSync(liveStatePath) === liveExistedBefore,
  'before=' + liveExistedBefore + ' after=' + fs.existsSync(liveStatePath))

for (const h of [home, homeC, homeD, homeE]) { try { fs.rmSync(h, { recursive: true, force: true }) } catch (_e) {} }

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + '  (' + pass + ' passed, ' + fail + ' failed)')
process.exit(fail === 0 ? 0 : 1)
