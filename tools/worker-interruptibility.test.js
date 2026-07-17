// worker-interruptibility.test.js - the SOFT (stand_down) + HARD (kill_worker)
// worker recall paths.
//
// Run with: node tools/worker-interruptibility.test.js
// Exit code 0 = all pass, non-zero = failure.
//
// Origin: 2026-07-18. A dispatched worker could not be stopped. It never read
// its inbox mid-run so a stand_down went unread; cancelling the scheduled row
// only stopped re-dispatch, not the live tab; and close_my_tab was self-only
// with no kill-other on the MCP surface. Tate closed the tab by hand.
//
// The load-bearing test in here is mass_close_impossible: the 2026-07-17
// incident mass-closed every live chat because a caller sent a filter
// ({viewColumn, viewType}) that matched them all. This asserts the kill path
// physically cannot construct such a call - it passes ONE exact tab_id and
// nothing else, on every branch.
// Doctrine: [[worker-interruptibility-soft-poll-hard-kill-2026-07-18]]

const fs = require('fs')
const path = require('path')
const os = require('os')

// ── sandbox (BEFORE requiring coord.js: COORD_ROOT is read at module load) ────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-interrupt-test-'))
process.env.COORD_ROOT = TMP
const WORKERS_DIR = path.join(TMP, 'workers')
const CONDUCTORS_DIR = path.join(TMP, 'conductors')
for (const d of [WORKERS_DIR, CONDUCTORS_DIR]) fs.mkdirSync(d, { recursive: true })

// ── stub cowork BEFORE coord lazily requires it ──────────────────────────────
// Records every call so we can assert the exact shape of what reaches the
// close layer, not just that a close happened.
const coworkPath = require.resolve('./cowork.js')
const coworkCalls = []
let coworkResult = { closed: true, refused: null, error: null }
require.cache[coworkPath] = {
  id: coworkPath,
  filename: coworkPath,
  loaded: true,
  exports: {
    kill_worker: async (params) => {
      coworkCalls.push(params)
      return coworkResult
    },
  },
}

const coord = require('./coord')
const scheduler = require('./scheduler')
const macDispatcher = require('./mac-dispatcher')
const { TOOLS } = require('../routes/mcpCoord')

// ── harness ──────────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const failures = []
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg) }
  else { failed++; failures.push(msg); console.log('  FAIL: ' + msg) }
}
const tests = []
function test(name, fn) { tests.push([name, fn]) }

function seedWorker(tab_id) {
  fs.writeFileSync(path.join(WORKERS_DIR, tab_id + '.json'), JSON.stringify({
    tab_id: tab_id,
    task_id: 'task-' + tab_id,
    tab_credential: 'cred-' + tab_id,
    tab_handle: { label: '[EOS-W-' + tab_id + '] build', viewColumn: 1, viewType: 'mainThreadWebview-claudeVSCodePanel', tabIndex: 2 },
  }), 'utf8')
}
function resetCowork() { coworkCalls.length = 0; coworkResult = { closed: true, refused: null, error: null } }

// ── HARD: kill_worker refusal rules ──────────────────────────────────────────

test('kill_worker refuses an identity-less call (no target_tab_id)', async () => {
  resetCowork()
  const r = await coord.kill_worker({}, { tab_id: 'conductor' })
  assert(r.closed === false, 'identity-less: nothing closed')
  assert(/identity_less_kill/.test(r.refused || ''), 'identity-less: refused with identity_less_kill (got: ' + r.refused + ')')
  assert(coworkCalls.length === 0, 'identity-less: never reached the close layer')
})

test('kill_worker refuses empty / whitespace / non-string targets', async () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    resetCowork()
    const r = await coord.kill_worker({ target_tab_id: bad }, {})
    assert(r.closed === false && !!r.refused, 'refused target_tab_id=' + JSON.stringify(bad))
    assert(coworkCalls.length === 0, 'no close attempted for target_tab_id=' + JSON.stringify(bad))
  }
})

test('kill_worker refuses wildcard / glob / "all" targets (no bulk kill exists)', async () => {
  for (const bad of ['*', '%', 'tab_*', 'all', 'ALL', '?']) {
    resetCowork()
    const r = await coord.kill_worker({ target_tab_id: bad }, {})
    assert(r.closed === false && /unsafe_or_wildcard_target/.test(r.refused || ''),
      'wildcard refused: ' + bad + ' (got: ' + r.refused + ')')
    assert(coworkCalls.length === 0, 'wildcard never reached close layer: ' + bad)
  }
})

test('kill_worker refuses path-traversal shaped ids (they reach a path.join)', async () => {
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '..']) {
    resetCowork()
    const r = await coord.kill_worker({ target_tab_id: bad }, {})
    assert(r.closed === false && !!r.refused, 'traversal refused: ' + JSON.stringify(bad))
    assert(coworkCalls.length === 0, 'traversal never reached close layer: ' + JSON.stringify(bad))
  }
})

test('kill_worker refuses the conductor tab (default id and registered id)', async () => {
  resetCowork()
  const r1 = await coord.kill_worker({ target_tab_id: 'conductor' }, {})
  assert(/conductor_tab_refused/.test(r1.refused || ''), 'default "conductor" id refused (got: ' + r1.refused + ')')
  assert(coworkCalls.length === 0, 'conductor never reached close layer')

  // A registered conductor row must be protected under its real tab id too.
  fs.writeFileSync(path.join(CONDUCTORS_DIR, 'current.json'), JSON.stringify({
    tab_id: 'tab_conductor_real_1', registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  }), 'utf8')
  seedWorker('tab_conductor_real_1')  // even WITH a worker row, conductor wins
  resetCowork()
  const r2 = await coord.kill_worker({ target_tab_id: 'tab_conductor_real_1' }, {})
  assert(/conductor_tab_refused/.test(r2.refused || ''), 'registered conductor tab refused (got: ' + r2.refused + ')')
  assert(coworkCalls.length === 0, 'registered conductor never reached close layer')
})

test('kill_worker refuses an unknown worker (no registry row)', async () => {
  resetCowork()
  const r = await coord.kill_worker({ target_tab_id: 'tab_does_not_exist_999' }, {})
  assert(r.closed === false && /unknown_worker/.test(r.refused || ''), 'unknown worker refused (got: ' + r.refused + ')')
  assert(coworkCalls.length === 0, 'unknown worker never reached close layer')
})

// ── HARD: kill_worker happy path + the mass-close impossibility ───────────────

test('kill_worker closes exactly the targeted worker', async () => {
  seedWorker('tab_victim_1')
  resetCowork()
  const r = await coord.kill_worker({ target_tab_id: 'tab_victim_1', reason: 'lane reclaimed' }, { tab_id: 'conductor' })
  assert(r.ok === true && r.closed === true, 'targeted worker closed')
  assert(r.target_tab_id === 'tab_victim_1', 'result names the target it closed')
  assert(r.killed_by === 'conductor', 'result records who killed it (audit)')
  assert(r.reason === 'lane reclaimed', 'result records why (audit)')
  assert(coworkCalls.length === 1, 'exactly ONE close call issued (got ' + coworkCalls.length + ')')
  assert(coworkCalls[0].tab_id === 'tab_victim_1', 'close call carried exactly the target id')
})

test('mass_close_impossible: the close layer only ever receives one exact id, never a filter', async () => {
  // The 2026-07-17 incident: a {viewColumn, viewType} filter matched every
  // Claude Code chat tab in the column and closed them all. Assert that no
  // input to kill_worker - including inputs deliberately shaped like that
  // filter - can produce a call carrying filter keys or multiple targets.
  seedWorker('tab_victim_2')
  seedWorker('tab_bystander_1')
  seedWorker('tab_bystander_2')

  const attacks = [
    { target_tab_id: 'tab_victim_2' },
    { target_tab_id: 'tab_victim_2', viewColumn: 1, viewType: 'mainThreadWebview-claudeVSCodePanel' },
    { target_tab_id: 'tab_victim_2', label: 'Claude Code', exactLabel: 'Claude Code', tabIndex: 0 },
    { target_tab_id: 'tab_victim_2', tab_id: 'tab_bystander_1' },  // caller identity must not become a target
  ]
  for (const atk of attacks) {
    resetCowork()
    await coord.kill_worker(atk, { tab_id: 'conductor' })
    assert(coworkCalls.length === 1, 'one call only for ' + JSON.stringify(atk))
    const sent = coworkCalls[0] || {}
    assert(sent.tab_id === 'tab_victim_2', 'target stayed tab_victim_2 for ' + JSON.stringify(atk))
    const filterKeys = ['viewColumn', 'viewType', 'label', 'exactLabel', 'tabIndex', 'force']
    const leaked = filterKeys.filter(k => k in sent)
    assert(leaked.length === 0, 'no filter keys reached the close layer (leaked: ' + leaked.join(',') + ')')
  }
})

test('kill_worker surfaces a refusal from the close layer instead of claiming success', async () => {
  seedWorker('tab_victim_3')
  resetCowork()
  coworkResult = { closed: false, refused: 'no_safe_tab_handle_or_incomplete', error: null }
  const r = await coord.kill_worker({ target_tab_id: 'tab_victim_3' }, {})
  assert(r.closed === false, 'refused close is reported as not closed')
  assert(r.refused === 'no_safe_tab_handle_or_incomplete', 'underlying refusal reason surfaces to the caller')
})

// ── HARD: the MCP surface (what the conductor can actually call) ──────────────

test('coord.kill_worker is exposed on the MCP tool surface', async () => {
  const t = TOOLS.find(x => x.name === 'coord.kill_worker')
  assert(!!t, 'coord.kill_worker present in TOOLS (this is the whole gap: it existed but was unreachable)')
  assert(t && t.inputSchema.required && t.inputSchema.required.includes('target_tab_id'),
    'target_tab_id is schema-required, so an identity-less kill fails before the handler')
})

test('MCP target param is target_tab_id, NOT tab_id (caller identity must not double as target)', async () => {
  const t = TOOLS.find(x => x.name === 'coord.kill_worker')
  assert(!!t.inputSchema.properties.target_tab_id, 'target_tab_id property exists')
  // mcpCoord injects tab_id/tab_credential into EVERY tool as caller identity.
  // If the target were named tab_id, those two meanings would collide in one call.
  assert(!!t.inputSchema.properties.tab_id, 'tab_id is still present as caller identity (injected)')
  assert(t.inputSchema.properties.tab_id.description !== t.inputSchema.properties.target_tab_id.description,
    'tab_id and target_tab_id are documented as distinct things')
})

test('kill_worker resolves through the coord tool router like every other coord.* tool', async () => {
  assert(typeof coord.kill_worker === 'function', 'coord.kill_worker is exported so callTool coord[short] finds it')
})

// ── the registry kill_worker depends on must resolve without an env var ───────

test('coord COORD_ROOT default is the real dir, not the Windows ghost (kill_worker reads this registry)', async () => {
  // kill_worker resolves its target through the worker registry, so if
  // COORD_ROOT silently resolves to the literal './D:\...' ghost dir on a Mac,
  // every worker looks unregistered and every kill refuses. This was dormant
  // only because the live process carried COORD_ROOT from an earlier bootstrap;
  // the laptop-agent plist never set it and kickstart -k does not re-read the
  // plist, so a reboot would have exposed it. Assert the DEFAULT (no env), in a
  // subprocess, because this module already set COORD_ROOT for its own sandbox.
  const { execFileSync } = require('child_process')
  const out = execFileSync(process.execPath, ['-e', `
    const path = require('path'), os = require('os')
    delete process.env.COORD_ROOT
    const coordSrc = require('fs').readFileSync(${JSON.stringify(path.join(__dirname, 'coord.js'))}, 'utf8')
    const m = coordSrc.match(/const COORD_ROOT = ([\\s\\S]*?)\\n\\)/)
    process.stdout.write(String(eval(m[1] + ')')))
  `], { encoding: 'utf8', env: Object.assign({}, process.env, { COORD_ROOT: '' }) })
  assert(!out.includes('D:'), 'default COORD_ROOT is not the Windows ghost path (got: ' + out + ')')
  assert(out.includes('.ecodiaos'), 'default COORD_ROOT points at the real ~/.ecodiaos coordination dir (got: ' + out + ')')
})

// ── SOFT: the stand-down clause is inherited by every dispatch ────────────────

function buildBrief() {
  return macDispatcher._composeBrief({
    tab_id: 'tab_test_1', task_id: 'task-test-1', tab_credential: 'cred-1',
    parent_conductor_tab_id: 'conductor', brief_body: 'do the thing',
    brief_size_bytes: 12, brief_storage: 'inline', brief_file_path: null,
  })
}

test('every dispatched brief inherits the stand-down clause by construction', async () => {
  const brief = buildBrief()
  assert(/STAND-DOWN CHECK/.test(brief), 'brief carries a STAND-DOWN CHECK block')
  assert(/coord_peek_inbox/.test(brief), 'brief tells the worker HOW to look (peek_inbox)')
  assert(/stand_down/.test(brief), 'brief names the stand_down message type to look for')
  assert(/status:"stood_down"/.test(brief), 'brief specifies the terminal stood_down status')
  assert(/coord_close_my_tab/.test(brief), 'brief tells a stood-down worker to close its tab')
  assert(/kill_worker/.test(brief), 'brief warns that ignoring a stand_down means a hard kill')
})

test('the stand-down clause is in the template, not the task body (authors cannot forget it)', async () => {
  // The task body here contains no stand-down text at all; if the clause still
  // appears, it came from composeBrief, which is what makes it inherited.
  const brief = macDispatcher._composeBrief({
    tab_id: 'tab_test_2', task_id: 'task-test-2', tab_credential: 'cred-2',
    parent_conductor_tab_id: 'conductor', brief_body: 'a brief whose author never heard of standing down',
    brief_size_bytes: 10, brief_storage: 'inline', brief_file_path: null,
  })
  assert(/STAND-DOWN CHECK/.test(brief), 'clause present despite a task body that never mentions it')
  assert(/tab_test_2/.test(brief) && /cred-2/.test(brief), 'clause is interpolated with THIS worker identity')
})

test('a file-storage brief also inherits the clause', async () => {
  const brief = macDispatcher._composeBrief({
    tab_id: 'tab_test_3', task_id: 'task-test-3', tab_credential: 'cred-3',
    parent_conductor_tab_id: 'conductor', brief_body: '', brief_size_bytes: 99999,
    brief_storage: 'file', brief_file_path: '/tmp/brief.md',
  })
  assert(/STAND-DOWN CHECK/.test(brief), 'file-storage brief carries the clause too')
})

// ── SOFT: stood_down is terminal, never a retry (the resurrection trap) ───────

function makeStubPool() {
  const queries = []
  return {
    _queries: queries,
    query(sql, params) {
      queries.push({ sql, params: params || [] })
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
  }
}
function makeRow(overrides) {
  return Object.assign({
    id: 'task-123', name: 'some-task', type: 'cron', status: 'active',
    cron_expression: '0 9 * * *', prompt: 'do it', preferred_account: 'code',
    retry_count: 0, dispatched_tab_id: null,
  }, overrides)
}

test('stood_down does NOT route through markFailed (which would re-dispatch it)', async () => {
  const pool = makeStubPool()
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => ({ closed: true }) })
  let markFailedCalled = false
  const realMarkFailed = scheduler.markFailed
  scheduler.markFailed = async () => { markFailedCalled = true }
  try {
    await scheduler.markComplete(makeRow({ id: 'sd-1', type: 'one_shot', cron_expression: null }),
      { status: 'stood_down', result_summary: 'stood down at phase 2' })
  } finally { scheduler.markFailed = realMarkFailed }
  assert(markFailedCalled === false,
    'stood_down did NOT hit markFailed (a retry here resurrects the worker the conductor just stopped)')
})

test('stood_down one_shot is cancelled, not completed (scope was abandoned)', async () => {
  const pool = makeStubPool()
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => ({ closed: true }) })
  await scheduler.markComplete(makeRow({ id: 'sd-2', type: 'one_shot', cron_expression: null }),
    { status: 'stood_down', result_summary: 'stood down' })
  const cancelled = pool._queries.find(q => q.sql.includes("status = 'cancelled'"))
  const completed = pool._queries.find(q => q.sql.includes("status = 'completed'"))
  assert(!!cancelled, 'stood_down one_shot row set to cancelled')
  assert(!completed, 'stood_down one_shot row NOT marked completed (it did not complete)')
})

test('stood_down does NOT wake chain children (they would build on abandoned work)', async () => {
  const pool = makeStubPool()
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => ({ closed: true }) })
  await scheduler.markComplete(makeRow({ id: 'sd-3', type: 'one_shot', cron_expression: null }),
    { status: 'stood_down', result_summary: 'stood down' })
  const chainWake = pool._queries.find(q => q.sql.includes('chain_after'))
  assert(!chainWake, 'no chain wake-up fired for a stood-down parent')
})

test('a successful run still wakes chain children (no regression from the stand-down branch)', async () => {
  const pool = makeStubPool()
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => ({ closed: true }) })
  await scheduler.markComplete(makeRow({ id: 'sd-4', type: 'one_shot', cron_expression: null }),
    { status: 'success', result_summary: 'done' })
  const chainWake = pool._queries.find(q => q.sql.includes('chain_after'))
  const completed = pool._queries.find(q => q.sql.includes("status = 'completed'"))
  assert(!!chainWake, 'success still wakes chain children')
  assert(!!completed, 'success still marks completed')
})

test('a genuine failure still routes through markFailed (no regression)', async () => {
  const pool = makeStubPool()
  scheduler._setPool(pool)
  scheduler._setDispatcher({ kill_worker: async () => ({ closed: true }) })
  let markFailedCalled = false
  const realMarkFailed = scheduler.markFailed
  scheduler.markFailed = async () => { markFailedCalled = true }
  try {
    await scheduler.markComplete(makeRow({ id: 'sd-5', type: 'one_shot', cron_expression: null }),
      { status: 'failed', result_summary: 'it broke' })
  } finally { scheduler.markFailed = realMarkFailed }
  assert(markFailedCalled === true, 'status=failed still reaches markFailed')
})

// ── run ──────────────────────────────────────────────────────────────────────
;(async () => {
  for (const [name, fn] of tests) {
    console.log('\n-- ' + name + ' --')
    try { await fn() } catch (e) { failed++; failures.push(name + ': threw ' + e.message); console.log('  FAIL (threw): ' + e.message) }
  }
  console.log('\n===========================================')
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed')
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('ALL TESTS PASSED')
  process.exit(0)
})()
