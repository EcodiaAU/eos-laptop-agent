'use strict'
// tools/pace-governor.test.js - the weekly pace governor (lane G7, 2026-09-29).
//
// Hermetic: no network, no Keychain, no registry file, no database. The governor's
// registry, probe, clock and log are injected; leaseDueRows and paceDispatchGate run
// against a recording fake pool. The band table is the REAL backend cronAusterity, so
// the core definition under test is the one the fleet ships, not a fixture.
//
// Cases P* grade the governor module, W* grade its wiring into scheduler.js.
// `node tools/pace-governor.test.js --mutate` deletes one gate at a time from a COPY
// of the real source and asserts the matching control goes RED. A control that
// survives its own mutation is agreeing, not working.
const fs = require('fs')
const path = require('path')

const GOV_PATH = process.env.PACE_GOVERNOR_MODULE || path.join(__dirname, 'pace-governor.js')
const SCHED_PATH = process.env.PACE_SCHEDULER_MODULE || path.join(__dirname, 'scheduler.js')
const CFG = require('/Users/ecodia/.code/ecodiaos/backend/src/config/cronAusterity')

const WEEK = 7 * 24 * 3600e3
const NOW = Date.parse('2026-10-10T00:00:00Z')
const resetFor = (elapsed) => new Date(NOW + (1 - elapsed) * WEEK).toISOString()
const reading = (u7, elapsed, extra) => Object.assign({
  utilization_5h: 0.10, utilization_7d: u7,
  resets_at_7d: elapsed === null ? null : resetFor(elapsed),
  probed_at: new Date(NOW).toISOString(), probe_status: 'ok',
}, extra || {})

let pass = 0, fail = 0
const failures = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; failures.push(label); console.log('  FAIL ' + label) }
}

// ── harness ──────────────────────────────────────────────────────────────────
function setup(gov, o) {
  const s = { probeCalls: 0, logs: [], now: NOW }
  gov._setDeps({
    registry: {
      enabled: () => (o.enabled || ['tate']).slice(),
      get: () => ({}),
    },
    probe: async () => {
      s.probeCalls++
      if (o.probeThrows) throw new Error('boom')
      return typeof o.reading === 'function' ? o.reading(s) : o.reading
    },
    now: () => s.now,
    log: (line) => s.logs.push(line),
  })
  return s
}

function fakePool(o) {
  o = o || {}
  const q = []
  return {
    q,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim()
      q.push({ sql: s, params: params || [] })
      if (/^WITH due AS/.test(s)) return { rows: [], rowCount: 0 }
      if (/^UPDATE os_scheduled_tasks d SET last_error/.test(s)) {
        const rows = o.signedRows || []
        return { rows, rowCount: rows.length }
      }
      if (/^SELECT name, type, prompt FROM os_scheduled_tasks/.test(s)) {
        return { rows: o.freshRow ? [o.freshRow] : [], rowCount: o.freshRow ? 1 : 0 }
      }
      return { rows: [], rowCount: 1 }
    },
  }
}

function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr)
  const lines = []
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  return { lines, restore: () => { process.stderr.write = orig } }
}

const leaseQ = (pool) => pool.q.find(x => /^WITH due AS/.test(x.sql))
const sigQ = (pool) => pool.q.find(x => /^UPDATE os_scheduled_tasks d SET last_error/.test(x.sql))
const bailQ = (pool) => pool.q.find(x => /PRE-SPAWN-BAIL: the pace governor/.test(x.sql))

async function run() {
  const gov = require(GOV_PATH)

  // ── governor module ────────────────────────────────────────────────────────
  {
    const s = setup(gov, { enabled: ['tate', 'code'], reading: reading(0.62, 0.31) })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.active === false && st.defer === false && s.probeCalls === 0,
      'P1. inert with 2 enabled accounts: not active, no defer, and no probe spent')
  }
  {
    setup(gov, { reading: reading(0.62, 0.31) })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.active === true && st.defer === true && st.rule === 'ahead-of-pace',
      'P2. defers at 7d 0.62 with 0.31 of the week elapsed (rule ' + st.rule + ')')
    ok(/^pace-governor: deferred, tate@ 7d 0\.62 vs 0\.31 elapsed/.test(st.signature || ''),
      'P2s. the signature names the account, the 7d reading and the elapsed share: ' + st.signature)
  }
  {
    setup(gov, { reading: reading(0.20, 0.31) })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.active === true && st.defer === false && st.signature === null,
      'P3. the same pace position at 0.20 used leases everything')
  }
  {
    setup(gov, { reading: reading(0.90, 0.95) })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.defer === true && st.rule === 'weekly-line', 'P4a. 0.90 used is over the 0.80 weekly line and defers')
    ok(gov.isCoreRow({ type: 'cron', name: 'gmail-inbox-poll' }, CFG) === true,
      'P4. a frozen-survivor cron (gmail-inbox-poll) is CORE and still leases at 0.90')
    ok(gov.isCoreRow({ type: 'cron', name: 'bas-quarterly-prep' }, CFG) === true,
      'P4c. a compliance cron (bas-quarterly-prep) is CORE')
    ok(gov.isCoreRow({ type: 'delayed', name: 'cowork.x-lane-A1', prompt: 'Do the thing.\nFREEZE-EXEMPT\nbecause inbound' }, CFG) === true,
      'P4f. a delayed row declaring FREEZE-EXEMPT on its own line is CORE')
    ok(gov.isCoreRow({ type: 'delayed', name: 'cowork.x-lane-A1', prompt: '  \t FREEZE-EXEMPT' }, CFG) === true,
      'P4g. leading whitespace before the declaration is allowed, as in migration 196')
    ok(gov.isCoreRow({ type: 'delayed', name: 'cowork.x-lane-A1', prompt: 'this brief is not FREEZE-EXEMPT at all' }, CFG) === false,
      'P4h. a MENTION of FREEZE-EXEMPT mid-line is not a declaration and is non-core')
    ok(gov.isCoreRow({ type: 'delayed', name: 'continuity-advance-chain' }, CFG) === true &&
       gov.isCoreRow({ type: 'delayed', name: 'cowork.away-ship-verify-abc123' }, CFG) === true,
      'P4k. the Continuity Engine rows (advance chain, away-ship-verify) are CORE')
    ok(gov.isCoreRow({ type: 'cron', name: 'autonomy-bar-sweep' }, CFG) === false &&
       gov.isCoreRow({ type: 'delayed', name: 'cowork.studio-lane-S1-build' }, CFG) === false,
      'P4n. CONTROL: a freeze-suppressed cron and a plain worker row are NON-core')
    ok(gov.isCoreRow({ type: 'delayed', name: 'gmail-inbox-poll' }, CFG) === false,
      'P4t. the band table grades CRONS: a one-off that borrows a core cron name is not core')
  }
  {
    const s = setup(gov, { reading: { probe_status: 'http_403' } })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.defer === false && st.failOpen === true && st.active === true,
      'P5. an unreadable probe (http_403, no reading) FAILS OPEN: no defer')
    ok(s.logs.some(l => /UNREADABLE/.test(l) && /FAIL-OPEN/.test(l)),
      'P5l. ...and says so loudly in the log')
    const s2 = setup(gov, { probeThrows: true })
    const st2 = await gov.evaluate({ austerityCfg: CFG })
    ok(st2.defer === false && st2.failOpen === true && s2.probeCalls === 1,
      'P5t. a probe that THROWS fails open too')
  }
  {
    setup(gov, { reading: reading(0.90, 0.95, { probed_at: new Date(NOW - 31 * 60000).toISOString(), probe_status: 'http_429' }) })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.defer === false && st.failOpen === true,
      'P6. a 31-minute-old carried reading is not a reading: fail open rather than brake on stale numbers')
    setup(gov, { reading: reading(0.90, 0.95, { probe_status: 'identity_mismatch' }) })
    const st2 = await gov.evaluate({ austerityCfg: CFG })
    ok(st2.defer === false && st2.failOpen === true, 'P6i. an identity-mismatched reading fails open')
  }
  {
    const s = setup(gov, { reading: reading(0.95, 0.95) })
    const st = await gov.evaluate({ austerityCfg: null })
    ok(st.defer === false && st.failOpen === true && s.probeCalls === 0,
      'P7. no band table means core cannot be identified: inert and fail-open, never "defer every cron"')
  }
  {
    const s = setup(gov, { reading: reading(0.62, 0.31) })
    await gov.evaluate({ austerityCfg: CFG })
    s.now = NOW + 4 * 60000
    await gov.evaluate({ austerityCfg: CFG })
    ok(s.probeCalls === 1, 'P8. two passes inside the 5-minute TTL spend ONE probe')
    s.now = NOW + 5 * 60000 + 1
    await gov.evaluate({ austerityCfg: CFG })
    ok(s.probeCalls === 2, 'P8b. the pass after the TTL refreshes')
  }
  {
    const core = new Set(gov.coreCronNames(CFG))
    const all = new Set(['a-cron-nobody-classified-2026'])
    for (const [, set] of CFG.GROUP_OF_SETS) for (const n of set) all.add(n)
    for (const n of CFG.FROZEN_SURVIVORS) all.add(n)
    const disagree = [...all].filter(n => core.has(n) !== gov.isCoreRow({ type: 'cron', name: n }, CFG))
    ok(disagree.length === 0 && core.size > 0,
      'P9. the SQL core list and the JS twin agree over all ' + all.size + ' known names + one unknown (' +
      core.size + ' core)' + (disagree.length ? ' DISAGREE: ' + disagree.join(',') : ''))
    ok(core.has('gmail-inbox-poll') && core.has('secrets-daily-audit') && !core.has('a-cron-nobody-classified-2026'),
      'P9b. inbound comms and security are in the list; an unclassified name is not')
  }
  {
    setup(gov, { reading: reading(0.62, null) })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.defer === false, 'P10. with no 7d reset time the pace rule cannot apply: 0.62 leases')
    setup(gov, { reading: reading(0.85, null) })
    const st2 = await gov.evaluate({ austerityCfg: CFG })
    ok(st2.defer === true && st2.rule === 'weekly-line', 'P10b. ...but the 0.80 weekly line still does')
  }
  {
    gov._setDeps({ registry: { enabled: () => { throw new Error('registry exploded') } }, log: () => {} })
    let threw = false, st = null
    try { st = await gov.evaluate({ austerityCfg: CFG }) } catch (_) { threw = true }
    ok(!threw && st && st.defer === false && st.failOpen === true,
      'P11. evaluate() never throws into leaseDueRows (whose catch pages Tate)')
  }
  {
    setup(gov, { reading: reading(0.29, 0.00) })
    const st = await gov.evaluate({ austerityCfg: CFG })
    ok(st.defer === false, 'P12. below the 0.30 floor a busy first day is not braked (0.29 used, 0.00 elapsed)')
  }

  // ── wiring into scheduler.js ───────────────────────────────────────────────
  const scheduler = require(SCHED_PATH)
  scheduler._setPaceGovernor(gov)
  scheduler._setAusterityCfg(CFG)

  {
    setup(gov, { reading: reading(0.62, 0.31) })
    const pool = fakePool({ signedRows: [{ id: 'r9', name: 'cowork.studio-lane-S1-build' }] })
    scheduler._setPool(pool)
    const cap = captureStderr()
    let rows
    try { rows = await scheduler.leaseDueRows(5) } finally { cap.restore() }
    const lq = leaseQ(pool)
    ok(!!lq && lq.params.length === 6 && Array.isArray(lq.params[2]) && lq.params[2].includes('gmail-inbox-poll') &&
       lq.params[5] === gov.FREEZE_EXEMPT_PG && /name = ANY\(\$3::text\[\]\)/.test(lq.sql) && /~ \$6\)/.test(lq.sql),
      'W1. deferring: the LEASE predicate itself narrows to core (core list, continuity names, FREEZE-EXEMPT regex bound)')
    const sq = sigQ(pool)
    ok(!!sq && sq.params[0] === gov.signature(gov.decidePace(reading(0.62, 0.31), NOW), 'tate@') &&
       /AND NOT \(\(d\.type = 'cron'/.test(sq.sql) && /IS DISTINCT FROM \$1/.test(sq.sql) &&
       !/next_run_at =|status = 'dispatching'|leased_by =/.test(sq.sql.split('WHERE')[0]),
      'W2. deferring: the SIGNATURE is written to the held-back non-core rows, guarded, touching no schedule column')
    ok(cap.lines.some(l => /pace-governor: DEFERRED 1 non-core row\(s\)/.test(l) && /cowork\.studio-lane-S1-build/.test(l)),
      'W2l. ...and the deferral is logged by name')
    ok(Array.isArray(rows) && rows.length === 0, 'W2r. leaseDueRows still returns its batch normally')
  }
  {
    setup(gov, { reading: reading(0.20, 0.31) })
    const pool = fakePool()
    scheduler._setPool(pool)
    const cap = captureStderr()
    try { await scheduler.leaseDueRows(5) } finally { cap.restore() }
    const lq = leaseQ(pool)
    ok(!!lq && lq.params.length === 2 && !/FREEZE|::text\[\]/.test(lq.sql) && !sigQ(pool),
      'W3. within pace: the lease statement is exactly the pre-governor one, and nothing is signed')
  }
  {
    const s = setup(gov, { enabled: ['tate', 'code'], reading: reading(0.95, 0.99) })
    const pool = fakePool()
    scheduler._setPool(pool)
    const cap = captureStderr()
    try { await scheduler.leaseDueRows(5) } finally { cap.restore() }
    const lq = leaseQ(pool)
    ok(!!lq && lq.params.length === 2 && !sigQ(pool) && s.probeCalls === 0,
      'W4. two enabled accounts: the governor is inert on the real lease path, even at 0.95')
  }
  {
    setup(gov, { reading: { probe_status: 'timeout' } })
    const pool = fakePool()
    scheduler._setPool(pool)
    const cap = captureStderr()
    try { await scheduler.leaseDueRows(5) } finally { cap.restore() }
    ok(leaseQ(pool).params.length === 2 && !sigQ(pool), 'W5. unreadable probe on the real lease path: leases normally')
  }
  {
    setup(gov, { reading: reading(0.90, 0.95) })
    const pool = fakePool({ freshRow: { name: 'cowork.studio-lane-S1-build', type: 'delayed', prompt: 'build it' } })
    const cap = captureStderr()
    let released
    try { released = await scheduler.paceDispatchGate(pool, { id: 'r1', leased_by: 'L1' }) } finally { cap.restore() }
    const bq = bailQ(pool)
    ok(released === true && !!bq && bq.params[0] === 'r1' && bq.params[1] === 'L1' &&
       /^pace-governor: deferred/.test(bq.params[2]) && !/next_run_at =/.test(bq.sql),
      'W6. dispatch-time twin: a non-core row leased before the reading turned hot is released WITH the signature')
  }
  {
    setup(gov, { reading: reading(0.90, 0.95) })
    const cases = [
      ['W7. dispatch-time twin: a core cron passes through at 0.90', { name: 'gmail-inbox-poll', type: 'cron', prompt: null }],
      ['W7f. dispatch-time twin: a FREEZE-EXEMPT row passes through at 0.90', { name: 'cowork.x-lane-A1', type: 'delayed', prompt: 'FREEZE-EXEMPT\ninbound reply' }],
      ['W7c. dispatch-time twin: the continuity chain passes through at 0.90', { name: 'continuity-advance-chain', type: 'delayed', prompt: 'x' }],
    ]
    for (const [label, freshRow] of cases) {
      const pool = fakePool({ freshRow })
      const released = await scheduler.paceDispatchGate(pool, { id: 'r2', leased_by: 'L2' })
      ok(released === false && !bailQ(pool), label)
    }
  }
  {
    setup(gov, { reading: reading(0.20, 0.31) })
    const pool = fakePool({ freshRow: { name: 'cowork.studio-lane-S1-build', type: 'delayed', prompt: 'x' } })
    const released = await scheduler.paceDispatchGate(pool, { id: 'r3', leased_by: 'L3' })
    ok(released === false && pool.q.length === 0,
      'W8. within pace the twin costs nothing: no select, no release')
  }
}

// ── mutation mode ────────────────────────────────────────────────────────────
const MUTATIONS = [
  { id: 'M1', file: 'scheduler.js', gate: 'the lease-path defer branch', expect: 'W1.',
    from: 'const paceDefer = !!(pace && pace.active && pace.defer && Array.isArray(pace.coreCrons))',
    to: 'const paceDefer = false && !!(pace && pace.active && pace.defer && Array.isArray(pace.coreCrons))' },
  { id: 'M2', file: 'pace-governor.js', gate: 'the ahead-of-pace rule', expect: 'P2.',
    from: "else if (elapsed !== null && u7 >= PACE_FLOOR && u7 > elapsed + PACE_MARGIN) rule = 'ahead-of-pace'",
    to: "else if (false) rule = 'ahead-of-pace'" },
  { id: 'M3', file: 'pace-governor.js', gate: 'the 0.80 weekly line', expect: 'P10b.',
    from: "if (u7 >= WARN_7D) rule = 'weekly-line'",
    to: "if (false) rule = 'weekly-line'" },
  { id: 'M4', file: 'pace-governor.js', gate: 'the core-cron exemption (JS twin)', expect: 'P4.',
    from: "if (row.type === 'cron' && austerityUsable(cfg) &&",
    to: "if (false && row.type === 'cron' && austerityUsable(cfg) &&" },
  { id: 'M5', file: 'pace-governor.js', gate: 'the core-cron list handed to SQL', expect: 'W1.',
    from: 'return [Array.isArray(coreCrons) ? coreCrons : [], ',
    to: 'return [[], ' },
  { id: 'M6', file: 'scheduler.js', gate: 'the core exemption in the dispatch-time twin', expect: 'W7.',
    from: 'if (!fresh || _paceGovernor.isCoreRow(fresh, _austerityCfg)) return false',
    to: 'if (!fresh) return false' },
  { id: 'M7', file: 'scheduler.js', gate: 'the signature write', expect: 'W2.',
    from: 'if (paceDefer && pace.signature) {',
    to: 'if (false) {' },
  { id: 'M8', file: 'pace-governor.js', gate: 'the reading-age bound', expect: 'P6.',
    from: "if (!Number.isFinite(u7) || r.probe_status === 'identity_mismatch' || !(age <= MAX_READING_AGE_MS)) {",
    to: "if (!Number.isFinite(u7) || r.probe_status === 'identity_mismatch') {" },
  { id: 'M9', file: 'pace-governor.js', gate: 'the single-account activation', expect: 'P1.',
    from: 'if (enabled.length !== 1) {',
    to: 'if (enabled.length < 1) {' },
  { id: 'M10', file: 'pace-governor.js', gate: 'the FREEZE-EXEMPT line anchor', expect: 'P4h.',
    from: 'const FREEZE_EXEMPT_RE = /(^|\\n)[ \\t\\n\\r\\f\\v]*FREEZE-EXEMPT/',
    to: 'const FREEZE_EXEMPT_RE = /FREEZE-EXEMPT/' },
]

if (process.argv.indexOf('--mutate') !== -1) {
  let mpass = 0, mfail = 0
  for (const m of MUTATIONS) {
    const src = fs.readFileSync(path.join(__dirname, m.file), 'utf8')
    if (src.indexOf(m.from) === -1) {
      console.log('  FAIL ' + m.id + ' target text not found in ' + m.file + ' - the mutation is stale, not the code')
      mfail++; continue
    }
    const mutant = path.join(__dirname, m.file.replace(/\.js$/, '.__mutant.js'))
    fs.writeFileSync(mutant, src.replace(m.from, m.to))
    const env = Object.assign({}, process.env)
    if (m.file === 'scheduler.js') env.PACE_SCHEDULER_MODULE = mutant
    else env.PACE_GOVERNOR_MODULE = mutant
    const r = require('child_process').spawnSync(process.execPath, [__filename], { encoding: 'utf8', env })
    try { fs.unlinkSync(mutant) } catch (_e) {}
    const out = (r.stdout || '') + (r.stderr || '')
    const control = out.split('\n').find(l => l.indexOf(' ' + m.expect + ' ') !== -1) || ''
    if (/^\s*FAIL/.test(control)) { mpass++; console.log('  ok   ' + m.id + ' deleting ' + m.gate + ' turns ' + m.expect + ' RED (the control is load-bearing)') }
    else { mfail++; console.log('  FAIL ' + m.id + ' deleting ' + m.gate + ' left ' + m.expect + ' ' + (control ? 'GREEN' : 'UNREPORTED') + ' - that control proves nothing') }
  }
  console.log('mutations: pass=' + mpass + ' fail=' + mfail)
  process.exit(mfail > 0 ? 1 : 0)
}

run().then(() => {
  console.log('pace-governor: pass=' + pass + ' fail=' + fail)
  if (fail) console.log('failed: ' + failures.join(' | '))
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.log('  FAIL harness threw: ' + ((e && e.stack) || e))
  process.exit(1)
})
