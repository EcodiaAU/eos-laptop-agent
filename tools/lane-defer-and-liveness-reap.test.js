'use strict'
// lane-defer-and-liveness-reap.test.js
//
// The two halves of the 2026-08-28 running-blind lane fix, each with the control
// that makes its pass meaningful:
//   A. leaseDueRows defers a due row whose lane already has a RUNNING holder
//      CONTROL: it must still lease when the holder is on a DIFFERENT lane, and
//      must still lease an unlaned row, or the predicate has simply stopped work.
//   B. livenessReapPass settles a provably-dead holder so the lane reopens
//      CONTROL: it must NOT touch a holder that is genuinely alive, must not act
//      inside the boot grace, and must reap nothing at all when the probe throws.
//
// The B controls are the ones that matter. A reaper that reaps everything frees
// every lane and would pass a naive "lane reopened" assertion while killing live
// workers, which is the exact failure adding 'running' to the trigger's supersede
// clause would have caused.
//
// Pure unit: an injected fake pool, an injected fake liveness probe, an injected
// stub dispatcher. Touches no database and no real transcript.

const assert = require('assert')
let pass = 0, fail = 0
function ok(c, label) { if (c) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label) } }

const scheduler = require('./scheduler')
const liveness = require('./worker-liveness')

// ── A. the lease-side defer predicate ────────────────────────────────────────
// leaseDueRows builds one SQL string; the predicate is structural, so assert on
// the SQL it issues rather than standing up Postgres.
function capturingPool() {
  const seen = []
  return { seen, query: async (sql, args) => { seen.push({ sql, args }); return { rows: [] } } }
}

async function testDeferSql() {
  const pool = capturingPool()
  scheduler._setPoolForTest ? scheduler._setPoolForTest(pool) : null
  // No injection seam for the pool on this path, so read the SQL from the source
  // of truth instead: the function body itself. Structural, not behavioural, and
  // it fails loudly the moment someone deletes the predicate.
  const src = scheduler.leaseDueRows.toString()
  ok(/NOT EXISTS/.test(src), 'A1. leaseDueRows carries a NOT EXISTS lane predicate')
  ok(/h\.status IN \('running', 'dispatching'\)/.test(src),
     'A2. the predicate excludes a lane held by a running OR dispatching row')
  ok(/os_sched_lane_key\(h\.name\) = os_sched_lane_key\(d\.name\)/.test(src),
     'A3. it matches on the lane key, not the row name')
  ok(/os_sched_lane_key\(h\.name\) IS NOT NULL/.test(src),
     'A4. CONTROL: an unlaned holder (lane key NULL) blocks nothing, so unlaned work still leases')
  ok(/h\.id <> d\.id/.test(src),
     'A5. CONTROL: a row can never defer against itself')
  ok(!/SET status = 'cancelled'[\s\S]{0,400}running/.test(src),
     'A6. CONTROL: the fix does NOT cancel the running holder')
}

// ── B. the liveness reaper ───────────────────────────────────────────────────
function fakePool(rows) {
  const updates = []
  return { updates, query: async (sql, args) => {
    if (/^\s*SELECT/i.test(sql)) return { rows }
    updates.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
    return { rowCount: 1 }
  } }
}
const stubDispatcher = { kill_worker: async () => ({ closed: true }) }

const ROW_DEAD = { id: 'r-dead', name: 'cowork.x-lane-A1-a', type: 'delayed', cron_expression: null,
  task_id: 't-dead', status: 'running', leased_at: new Date(Date.now() - 120 * 60000).toISOString(),
  dispatched_tab_id: 'tab_17000000000_deadbeef' }
const ROW_LIVE = { id: 'r-live', name: 'cowork.x-lane-A1-b', type: 'delayed', cron_expression: null,
  task_id: 't-live', status: 'running', leased_at: new Date(Date.now() - 120 * 60000).toISOString(),
  dispatched_tab_id: 'tab_17000000001_cafef00d' }
const ROW_CRON = { id: 'r-cron', name: 'nightly-thing', type: 'cron', cron_expression: '0 3 * * *',
  task_id: 't-cron', status: 'running', leased_at: new Date(Date.now() - 300 * 60000).toISOString(),
  dispatched_tab_id: 'tab_17000000002_0badcafe' }
const ROW_FRESH = { id: 'r-fresh', name: 'cowork.x-lane-B2-a', type: 'delayed', cron_expression: null,
  task_id: 't-fresh', status: 'running', leased_at: new Date(Date.now() - 2 * 60000).toISOString(),
  dispatched_tab_id: 'tab_17000000003_feedface' }

function stubLiveness(verdictById) {
  return { probeRows: (rows) => rows.map(r => ({
    id: r.id, name: r.name, tab_id: r.dispatched_tab_id,
    verdict: verdictById[r.id] || 'unknown', reason: 'stub', evidence: {} })) }
}

async function testReaper() {
  // B1 + B2: exactly the dead one is settled, the live one is untouched.
  let pool = fakePool([ROW_DEAD, ROW_LIVE])
  let t = await scheduler.livenessReapPass({ pool, dispatcher: stubDispatcher,
    liveness: stubLiveness({ 'r-dead': 'dead', 'r-live': 'live' }) })
  ok(t.reaped === 1 && t.live === 1, 'B1. one dead row settled, one live row counted live')
  const touched = pool.updates.map(u => u.args[0])
  ok(touched.includes('r-dead'), 'B2. the dead row was settled')
  ok(!touched.includes('r-live'), 'B2b. CONTROL: the LIVE holder on the same lane was not touched')
  ok(/status = 'orphaned'/.test(pool.updates[0].sql), 'B3. a one-shot settles terminal as orphaned')
  ok(/AND status = 'running'/.test(pool.updates[0].sql),
     'B3b. the settle is guarded on status still being running, so it cannot clobber a concurrent write')

  // B4: a cron row returns to active at its next boundary, not orphaned, so it
  // keeps its schedule.
  pool = fakePool([ROW_CRON])
  t = await scheduler.livenessReapPass({ pool, dispatcher: stubDispatcher,
    liveness: stubLiveness({ 'r-cron': 'dead' }) })
  ok(t.reaped === 1 && /status = 'active'/.test(pool.updates[0].sql),
     'B4. a dead CRON row returns to active with a recomputed next_run_at')

  // B5: unknown is never actionable.
  pool = fakePool([ROW_FRESH])
  t = await scheduler.livenessReapPass({ pool, dispatcher: stubDispatcher,
    liveness: stubLiveness({ 'r-fresh': 'unknown' }) })
  ok(t.reaped === 0 && pool.updates.length === 0,
     'B5. CONTROL: verdict unknown settles nothing')

  // B6: a throwing probe reaps nothing at all.
  pool = fakePool([ROW_DEAD, ROW_LIVE])
  t = await scheduler.livenessReapPass({ pool, dispatcher: stubDispatcher,
    liveness: { probeRows: () => { throw new Error('probe exploded') } } })
  ok(t.reaped === 0 && pool.updates.length === 0 && t.error,
     'B6. CONTROL: a probe that throws reaps nothing (fails toward the status quo)')

  // B7: no running rows is a clean no-op, not a crash.
  pool = fakePool([])
  t = await scheduler.livenessReapPass({ pool, dispatcher: stubDispatcher, liveness: stubLiveness({}) })
  ok(t.scanned === 0 && t.reaped === 0, 'B7. an empty running set is a no-op')
}

// ── C. the probe itself, against real files ──────────────────────────────────
const fs = require('fs'), os_ = require('os'), path = require('path')
async function testProbe() {
  const root = fs.mkdtempSync(path.join(os_.tmpdir(), 'liveness-'))
  const proj = path.join(root, 'projects', 'p1'); fs.mkdirSync(proj, { recursive: true })
  process.env.EOS_TRANSCRIPTS_DIR = path.join(root, 'projects')
  process.env.EOS_WORKTREES_DIR = path.join(root, 'worktrees')
  process.env.EOS_COORD_WORKERS_DIR = path.join(root, 'workers')
  delete require.cache[require.resolve('./worker-liveness')]
  const L = require('./worker-liveness')

  const LIVE_TAB = 'tab_1787000000001_b4f89246'
  const DEAD_TAB = 'tab_1787000000002_deadbeef'
  fs.writeFileSync(path.join(proj, 's-live.jsonl'),
    JSON.stringify({ type: 'user', content: 'boot envelope tab_id: ' + LIVE_TAB }) + '\n')
  const oldFile = path.join(proj, 's-old.jsonl')
  fs.writeFileSync(oldFile, JSON.stringify({ type: 'user', content: 'tab_id: ' + DEAD_TAB }) + '\n')
  const old = Date.now() / 1000 - 6 * 3600
  fs.utimesSync(oldFile, old, old)

  const tabs = L.liveTabs(30)
  ok(tabs.has(LIVE_TAB), 'C1. a transcript written now marks its own tab live')
  ok(!tabs.has(DEAD_TAB), 'C2. CONTROL: a transcript 6h stale does NOT mark its tab live')

  const leased = new Date(Date.now() - 120 * 60000).toISOString()
  const v = L.probeRows([
    { id: 1, name: 'a', task_id: 'ta', leased_at: leased, dispatched_tab_id: LIVE_TAB },
    { id: 2, name: 'b', task_id: 'tb', leased_at: leased, dispatched_tab_id: DEAD_TAB },
    { id: 3, name: 'c', task_id: 'tc', leased_at: new Date(Date.now() - 60000).toISOString(), dispatched_tab_id: DEAD_TAB },
    { id: 4, name: 'd', task_id: 'td', leased_at: leased, dispatched_tab_id: null },
  ], { live_tabs: tabs })
  const byId = Object.fromEntries(v.map(x => [x.id, x.verdict]))
  ok(byId[1] === 'live', 'C3. live transcript -> live')
  ok(byId[2] === 'dead', 'C4. silent past the window -> dead')
  ok(byId[3] === 'unknown', 'C5. CONTROL: leased 1 minute ago -> unknown, never dead (boot race)')
  ok(byId[4] === 'unknown', 'C6. CONTROL: no dispatched_tab_id -> unknown, never dead')

  // Worktree fallback: a tab with no live transcript but a freshly written
  // worktree is alive.
  const wt = path.join(root, 'worktrees', 'tb'); fs.mkdirSync(wt, { recursive: true })
  fs.writeFileSync(path.join(wt, 'edited.txt'), 'work in progress')
  const v2 = L.probeRows([{ id: 2, name: 'b', task_id: 'tb', leased_at: leased, dispatched_tab_id: DEAD_TAB }],
    { live_tabs: tabs })
  ok(v2[0].verdict === 'live', 'C7. CONTROL: a freshly written worktree rescues a tab with no live transcript')

  // C8/C9: the two-negative rule inside the confirmation window.
  const recent = new Date(Date.now() - 25 * 60000).toISOString()
  const v3 = L.probeRows([{ id: 9, name: 'e', task_id: 'te', leased_at: recent, dispatched_tab_id: DEAD_TAB }],
    { live_tabs: tabs })
  ok(v3[0].verdict === 'unknown',
     'C8. CONTROL: silent for 25m with no registry termination is unknown, not dead')
  fs.mkdirSync(path.join(root, 'workers'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workers', DEAD_TAB + '.json'),
    JSON.stringify({ tab_id: DEAD_TAB, terminated_at: new Date().toISOString() }))
  const v4 = L.probeRows([{ id: 9, name: 'e', task_id: 'te', leased_at: recent, dispatched_tab_id: DEAD_TAB }],
    { live_tabs: tabs })
  ok(v4[0].verdict === 'dead',
     'C9. the SECOND negative (registry records it terminated) confirms death inside the window')

  try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {}
}

;(async () => {
  console.log('lane-defer + liveness-reap suite')
  await testDeferSql()
  await testReaper()
  await testProbe()
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
