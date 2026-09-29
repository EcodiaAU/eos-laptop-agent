// pace-governor-gate.cjs - G7. Proves, against the REAL database, that the weekly pace
// governor's SQL does what its hermetic suite assumes:
//   half 1  the core predicate (sqlCorePredicate + sqlCoreParams, the very functions
//           leaseDueRows calls) selects exactly the core rows, and the Postgres
//           FREEZE-EXEMPT regex agrees with the JS twin row by row;
//   half 2  the EXACT lease and signature statements leaseDueRows emits while deferring
//           (captured off a recording pool, not retyped) parse and plan on Postgres with
//           their real bound parameters, so a param-type or numbering slip fails here and
//           not in the live dispatch loop, whose catch pages Tate;
//   half 3  the live population the predicate grades is counted, so the gate cannot pass
//           against a predicate that matches nothing real.
//
// Everything that writes happens inside ONE transaction that always ROLLS BACK, and half 2
// is EXPLAIN only (planned, never executed), so no live row is leased or signed.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { Pool } = require('pg')
const gov = require('../tools/pace-governor')
const scheduler = require('../tools/scheduler')

const CORE_CRON = 'pgtest-g7-core-cron'
const ROWS = [
  // [name, type, prompt, expectCore]
  [CORE_CRON, 'cron', 'core cron by band table', true],
  ['pgtest-g7-noncore-cron', 'cron', 'suppressed-under-freeze cron', false],
  ['cowork.pgtestg7-fe-own-line', 'delayed', 'Do the work.\nFREEZE-EXEMPT\nbecause it is inbound', true],
  ['cowork.pgtestg7-fe-indented', 'delayed', 'Intro\n  \tFREEZE-EXEMPT', true],
  ['cowork.pgtestg7-fe-first-line', 'delayed', 'FREEZE-EXEMPT\nfirst line counts', true],
  ['cowork.pgtestg7-fe-mention', 'delayed', 'this brief is not FREEZE-EXEMPT at all', false],
  ['cowork.pgtestg7-fe-lowercase', 'delayed', 'freeze-exempt\nlowercase is not the token', false],
  ['continuity-advance-chain', 'delayed', 'continuity chain', true],
  ['cowork.away-ship-verify-pgtestg7', 'delayed', 'continuity verify successor', true],
  ['cowork.away-ship-verifyXpgtestg7', 'delayed', 'prefix without its hyphen', false],
  ['cowork.pgtestg7-plain', 'delayed', 'an ordinary worker brief', false],
]

let pass = 0, fail = 0
const ok = (c, l) => { c ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l)) }

;(async () => {
  const src = scheduler.leaseDueRows.toString()
  ok(src.includes("sqlCorePredicate('d', 3)") && src.includes("sqlCorePredicate('d', 2)") &&
     src.includes('sqlCoreParams(pace.coreCrons)'),
    'G7-0. leaseDueRows builds its clause from the functions this gate exercises')

  const stubCfg = {
    GROUP_OF_SETS: [['x', new Set([CORE_CRON, 'pgtest-g7-noncore-cron'])]],
    FROZEN_SURVIVORS: new Set([CORE_CRON]),
    decidePosture: (n) => ({ suppressed: n !== CORE_CRON }),
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000, max: 1 })
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query("SET LOCAL statement_timeout = '20s'")
    await c.query("SET LOCAL lock_timeout = '2s'")
    const ids = []
    for (const [name, type, prompt] of ROWS) {
      const r = await c.query(
        `INSERT INTO os_scheduled_tasks (type, name, prompt, status, next_run_at, cron_expression)
         VALUES ($1, $2, $3, 'active', NOW() - interval '1 minute', $4) RETURNING id`,
        [type, name, prompt, type === 'cron' ? '0 3 * * *' : null])
      ids.push(r.rows[0].id)
    }

    // ── half 1: semantics + regex parity ──────────────────────────────────────
    const coreParams = gov.sqlCoreParams(gov.coreCronNames(stubCfg))
    const sel = await c.query(
      `SELECT d.id, d.name, d.type, d.prompt FROM os_scheduled_tasks d
        WHERE d.id = ANY($1::uuid[]) AND ${gov.sqlCorePredicate('d', 2)}`, [ids, ...coreParams])
    const sqlCore = new Set(sel.rows.map(r => r.name))
    for (const [name, type, prompt, expectCore] of ROWS) {
      ok(sqlCore.has(name) === expectCore, 'G7-1. SQL ' + (expectCore ? 'KEEPS  ' : 'DEFERS ') + name)
      const js = gov.isCoreRow({ name, type, prompt }, stubCfg)
      ok(js === sqlCore.has(name), 'G7-2. JS twin agrees with Postgres on ' + name + ' (' + js + ')')
    }

    // ── half 2: the exact emitted statements plan on Postgres ─────────────────
    const captured = []
    scheduler._setPool({ async query(sql, params) {
      captured.push({ sql, params })
      return /^\s*WITH due AS/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }
    } })
    const deferState = {
      active: true, defer: true, coreCrons: gov.coreCronNames(require('/Users/ecodia/.code/ecodiaos/backend/src/config/cronAusterity')),
      signature: 'pace-governor: deferred, gate@ 7d 0.62 vs 0.31 elapsed (gate)',
    }
    scheduler._setPaceGovernor(Object.assign({}, gov, { evaluate: async () => deferState }))
    await scheduler.leaseDueRows(5)
    const lease = captured.find(x => /^\s*WITH due AS/.test(x.sql))
    const sig = captured.find(x => /UPDATE os_scheduled_tasks d\s+SET last_error/.test(x.sql))
    ok(!!lease && !!sig, 'G7-3. captured both statements leaseDueRows emits while deferring')
    for (const [label, st] of [['lease', lease], ['signature', sig]]) {
      let planned = false, err = ''
      try { await c.query('SAVEPOINT p'); await c.query('EXPLAIN ' + st.sql, st.params); planned = true; await c.query('RELEASE SAVEPOINT p') }
      catch (e) { err = e.message; await c.query('ROLLBACK TO SAVEPOINT p') }
      ok(planned, 'G7-4. the ' + label + ' statement parses and plans with its real ' + st.params.length +
        ' bound parameters' + (err ? ' (' + err + ')' : ''))
    }

    // ── half 4: the cap-marker matched pair, EXECUTED (still rolled back) ───────
    // Both governor writes replace last_error. A row whose last_error carries the
    // AllAccountsCappedError marker holds a retry_count BORROWED by the capped defer,
    // which markFailed and EFFECTIVE_RETRY_COUNT_SQL read as 0 only while the marker is
    // there. Each captured statement is executed here on two otherwise identical rows,
    // one marked and one not: the marked row must come out at retry_count 0 and the
    // control must keep its 2, so the neutralisation is proved to be conditional
    // rather than a blanket reset. The signature statement is scoped to the pair by an
    // appended id filter, so no live row is touched even inside the transaction.
    const MARK = scheduler.CAPPED_MARKER_TOKEN
    const mkPair = async (tag, status) => {
      const out = {}
      for (const [key, err] of [['capped', MARK + ': every enabled account is capped (gate ' + tag + ')'],
                                ['plain', 'transient dispatch error (gate ' + tag + ' control)']]) {
        const r = await c.query(
          `INSERT INTO os_scheduled_tasks (type, name, prompt, status, next_run_at, retry_count, last_error, leased_by, leased_at)
           VALUES ('delayed', $1, 'an ordinary worker brief', $2, NOW() - interval '1 minute', 2, $3, $4, $5) RETURNING id`,
          ['cowork.pgtestg7-' + tag + '-' + key, status, err,
           status === 'dispatching' ? 'gate-lease' : null, status === 'dispatching' ? new Date() : null])
        out[key] = r.rows[0].id
        ids.push(out[key]) // half 3 counts the live population without the gate's own rows
      }
      return out
    }
    const readPair = async (p) => {
      const r = await c.query('SELECT id, retry_count, last_error, status, leased_by FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])',
        [[p.capped, p.plain]])
      const by = {}
      for (const row of r.rows) by[row.id === p.capped ? 'capped' : 'plain'] = row
      return by
    }

    const sp = await mkPair('sig', 'active')
    const scoped = sig.sql.replace(/RETURNING d\.id, d\.name\s*$/,
      'AND d.id = ANY($' + (sig.params.length + 1) + '::uuid[]) RETURNING d.id, d.name')
    ok(scoped !== sig.sql, 'G7-7. the signature statement can be scoped to the test pair (its RETURNING tail is where the gate expects it)')
    const sigRun = await c.query(scoped, [...sig.params, [sp.capped, sp.plain]])
    const s1 = await readPair(sp)
    ok(sigRun.rowCount === 2 && s1.capped.last_error === deferState.signature && s1.plain.last_error === deferState.signature,
      'G7-8. the signature write lands on both held non-core rows (' + sigRun.rowCount + ')')
    ok(s1.capped.retry_count === 0,
      'G7-9. signature write: the CAP-MARKED row loses its borrowed retry_count with its marker (2 -> ' + s1.capped.retry_count + ')')
    ok(s1.plain.retry_count === 2,
      'G7-10. CONTROL signature write: an identical row without the marker keeps its real failure count (2 -> ' + s1.plain.retry_count + ')')
    const sigAgain = await c.query(scoped, [...sig.params, [sp.capped, sp.plain]])
    ok(sigAgain.rowCount === 0, 'G7-11. the IS DISTINCT FROM guard holds: an unchanged reading re-signs nothing (' + sigAgain.rowCount + ')')

    const tp = await mkPair('twin', 'dispatching')
    for (const key of ['capped', 'plain']) {
      const cap2 = []
      const twinPool = { async query(sql, params) {
        cap2.push({ sql, params })
        return /^\s*SELECT name, type, prompt/.test(sql)
          ? { rows: [{ name: 'cowork.pgtestg7-twin-' + key, type: 'delayed', prompt: 'an ordinary worker brief' }], rowCount: 1 }
          : { rows: [], rowCount: 1 }
      } }
      const released = await scheduler.paceDispatchGate(twinPool, { id: tp[key], leased_by: 'gate-lease' })
      const upd = cap2.find(x => /PRE-SPAWN-BAIL: the pace governor/.test(x.sql))
      ok(released === true && !!upd, 'G7-12. the dispatch-time twin emits its release for the ' + key + ' row')
      if (upd) await c.query(upd.sql, upd.params)
    }
    const t1 = await readPair(tp)
    ok(t1.capped.status === 'active' && t1.capped.leased_by === null && t1.capped.last_error === deferState.signature &&
       t1.capped.retry_count === 0,
      'G7-13. dispatch-time twin: the CAP-MARKED row is released and loses its borrowed retry_count (2 -> ' + t1.capped.retry_count + ')')
    ok(t1.plain.status === 'active' && t1.plain.retry_count === 2,
      'G7-14. CONTROL dispatch-time twin: an identical row without the marker keeps its real failure count (2 -> ' + t1.plain.retry_count + ')')

    // ── half 3: the live population, counted ──────────────────────────────────
    const live = await c.query(
      `SELECT count(*) FILTER (WHERE ${gov.sqlCorePredicate('d', 1)})::int AS core,
              count(*) FILTER (WHERE NOT ${gov.sqlCorePredicate('d', 1)})::int AS noncore,
              count(*) FILTER (WHERE d.type = 'cron' AND d.name = ANY($1::text[]))::int AS core_crons,
              count(*) FILTER (WHERE COALESCE(d.prompt, '') ~ $4)::int AS freeze_exempt
         FROM os_scheduled_tasks d
        WHERE d.archived_at IS NULL AND d.status NOT IN ('cancelled', 'completed', 'failed')
          AND NOT (d.id = ANY($5::uuid[]))`,
      [...gov.sqlCoreParams(deferState.coreCrons), ids])
    const L = live.rows[0]
    console.log('       live non-terminal rows: core=' + L.core + ' non-core=' + L.noncore +
      ' (core crons=' + L.core_crons + ', FREEZE-EXEMPT prompts=' + L.freeze_exempt + ')')
    ok(L.core_crons >= 10, 'G7-5. the core-cron list matches the live frozen-survivor + compliance crons (' + L.core_crons + ')')
    ok(L.noncore > 0, 'G7-6. CONTROL: the predicate does not call everything core (' + L.noncore + ' non-core)')

    await c.query('ROLLBACK')
  } catch (e) {
    try { await c.query('ROLLBACK') } catch (_) {}
    ok(false, 'gate threw: ' + e.message)
  } finally {
    c.release(); await pool.end()
  }
  console.log('pace-governor-gate: pass=' + pass + ' fail=' + fail)
  process.exit(fail > 0 ? 1 : 0)
})()
