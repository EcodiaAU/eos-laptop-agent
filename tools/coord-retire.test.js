'use strict'
// coord-retire.test.js - negative-controlled suite for the inbox retirement sweep.
//
// The control that matters: a sweep that retires everything would "pass" a naive
// count assertion while destroying the conductor's attention queue. So every
// retirement assertion here is paired with a SURVIVAL assertion on a message
// that must not be touched. Cases 3, 4, 5, 6 and 9 are those controls.
//
// Runs against a temp COORD_ROOT and an injected fake pool. Never touches the
// real message store or the real database.

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-retire-test-'))
process.env.EOS_COORD_ROOT = ROOT
process.env.COORD_ROOT = ROOT

let pass = 0, fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label) }
}

// Fake pg pool: answers the ANY($1::text[]) lookup from a fixture map.
function fakePool(rows) {
  return { query: async (_sql, args) => {
    const want = new Set(args[0])
    return { rows: rows.filter(r => want.has(r.id)) }
  } }
}
function throwingPool() { return { query: async () => { throw new Error('boom') } } }

const TOPIC = 'chat.conductor.inbox'
function iso(msAgo) { return new Date(Date.now() - msAgo).toISOString() }
const MIN = 60_000, DAY = 86_400_000

// Fixtures are written straight to the store BEFORE coord is required: coord
// hydrates its in-memory index from disk at module load, exactly as it does on a
// real boot, so seeding first is what makes the fixture and the process agree.
function seed(msgs) {
  const dir = path.join(ROOT, 'messages')
  fs.mkdirSync(dir, { recursive: true })
  const inbox = path.join(ROOT, 'inbox', TOPIC.replace(/[^a-zA-Z0-9._-]/g, '_'))
  fs.mkdirSync(inbox, { recursive: true })
  for (const m of msgs) {
    fs.writeFileSync(path.join(dir, m.id + '.json'), JSON.stringify(m))
    fs.writeFileSync(path.join(inbox, m.id), '')
  }
}

function msg(id, type, task_id, ageMs, extra) {
  return Object.assign({
    id, from: 'tab_x', to: TOPIC,
    body: Object.assign({ type, task_id }, extra || {}),
    task_id, in_reply_to: null,
    created_at: iso(ageMs), seen_at: null, acknowledged_at: null, action_summary: null,
  })
}

const FIXTURES = (() => {
  const f = [
    msg('m-done-terminal',   'done',      't-completed', 3 * 60 * MIN),
    msg('m-bound-terminal',  'bound',     't-cancelled', 3 * 60 * MIN),
    msg('m-prog-terminal',   'progress',  't-orphaned',  3 * 60 * MIN),
    msg('m-done-running',    'done',      't-running',   3 * 60 * MIN),   // control 3
    msg('m-escalation-old',  'escalation','t-completed', 30 * DAY),        // control 4
    msg('m-chat-old',        'chat',      null,          30 * DAY),        // control 4
    msg('m-done-fresh',      'done',      't-completed', 5 * MIN),         // control 5
    msg('m-done-dangling-fresh', 'done',  't-missing',   2 * DAY),         // control 6
    msg('m-done-dangling-old',   'done',  't-missing',   30 * DAY),
    msg('m-bound-no-task',   'bound',     null,          2 * DAY),         // control 9
    msg('m-bound-no-task-old','bound',    null,          30 * DAY),
    msg('m-done-cron-old',   'done',      't-cron-live',  5 * DAY),         // superseded by a later fire
    msg('m-done-cron-now',   'done',      't-cron-live',  3 * 60 * MIN),    // control 14: THIS fire
  ]
  seed(f)
  return f
})()

const coord = require('./coord')
const retire = require('./coord-retire')

async function main() {
  console.log('coord-retire suite (root ' + ROOT + ', ' + FIXTURES.length + ' fixtures)')

  const rows = [
    { id: 't-completed', status: 'completed', archived_at: null },
    { id: 't-cancelled', status: 'cancelled', archived_at: null },
    { id: 't-orphaned',  status: 'orphaned',  archived_at: null },
    { id: 't-running',   status: 'running',   archived_at: null },
    // A cron row sits in 'active' between fires forever. Its last fire ran 4h
    // ago, so anything written BEFORE that is history and anything written after
    // belongs to the fire still in flight.
    { id: 't-cron-live', status: 'active', archived_at: null,
      last_run_at: new Date(Date.now() - 4 * 60 * MIN).toISOString(), leased_at: null },
  ]

  // ── 1. negative control: PRE-FIX behaviour is that nothing retires ────────
  const s0 = await retire.status({ topic: TOPIC })
  ok(s0.unseen === 13, '1. baseline: 13 unseen seeded (got ' + s0.unseen + ')')
  ok(s0.lifecycle === 11 && s0.attention === 2,
     '1b. status splits the bus: 11 lifecycle / 2 attention (got ' + s0.lifecycle + '/' + s0.attention + ')')

  // ── 2. dry run mutates nothing ───────────────────────────────────────────
  retire._setPool(fakePool(rows))
  const dry = await retire.sweep({ topic: TOPIC, dry_run: true })
  ok(dry.retired === 0, '2. dry_run retires 0 (got ' + dry.retired + ')')
  ok(dry.retirable === 6, '2b. dry_run counts 6 retirable (got ' + dry.retirable + ')')
  ok((await retire.status({ topic: TOPIC })).unseen === 13, '2c. dry_run left the store untouched')

  // ── 3-9. the real sweep ──────────────────────────────────────────────────
  const r = await retire.sweep({ topic: TOPIC })
  const after = coord._unseenForTopic(TOPIC).map(m => m.id)
  const gone = id => !after.includes(id)

  ok(r.retired === 6, '3. retired exactly 6 settled lifecycle messages (got ' + r.retired + ')')
  ok(gone('m-done-terminal') && gone('m-bound-terminal') && gone('m-prog-terminal'),
     '3b. completed / cancelled / orphaned rows all retire')
  ok(gone('m-done-dangling-old'), '3c. a 30-day dangling done retires')

  // CONTROLS. Each of these surviving is the whole point.
  ok(!gone('m-done-running'),        '4. CONTROL: a done for a still-RUNNING row survives')
  ok(!gone('m-escalation-old'),      '5. CONTROL: a 30-day escalation survives (attention is never retired by type)')
  ok(!gone('m-chat-old'),            '6. CONTROL: a 30-day chat survives')
  ok(!gone('m-done-fresh'),          '7. CONTROL: a done inside the grace window survives')
  ok(!gone('m-done-dangling-fresh'), '8. CONTROL: a 2-day dangling done survives (row may not exist YET)')
  ok(!gone('m-bound-no-task'),
     '9. CONTROL: a 2-day lifecycle message with no task_id survives (its row may not be joinable YET)')
  ok(gone('m-bound-no-task-old'),
     '9a. a 30-day lifecycle message with no task_id retires: no row will ever settle it')
  ok(gone('m-done-cron-old'),
     '9b. a done for a still-ACTIVE cron row retires once a later fire has run')
  ok(!gone('m-done-cron-now'),
     '9c. CONTROL: a done written AFTER the row last fired is the current fire and survives')

  // ── 10. idempotence: a second sweep retires nothing new ──────────────────
  const r2 = await retire.sweep({ topic: TOPIC })
  ok(r2.retired === 0, '10. second sweep is a no-op (got ' + r2.retired + ')')

  // ── 11. fail-toward-status-quo on a DB error ─────────────────────────────
  retire._setPool(throwingPool())
  const rErr = await retire.sweep({ topic: TOPIC })
  ok(rErr.ok === false && rErr.retired === 0, '11. CONTROL: a task-state lookup error retires nothing')
  ok(coord._unseenForTopic(TOPIC).length === 7, '11b. store unchanged after the error (7 remain)')

  // ── 12. digest writes content BEFORE marking, and survives nothing-to-do ─
  retire._setPool(fakePool(rows))
  const d = await retire.digest({ topic: TOPIC, older_than_days: 7, out_dir: path.join(ROOT, 'digests') })
  ok(d.digested === 2, '12. digest retired the 2 stale attention messages (got ' + d.digested + ')')
  const body = fs.readFileSync(d.digest_file, 'utf8')
  ok(body.includes('m-escalation-old') && body.includes('m-chat-old'),
     '12b. digest file holds the full content of both before they were marked')
  const d2 = await retire.digest({ topic: TOPIC, older_than_days: 7, out_dir: path.join(ROOT, 'digests') })
  ok(d2.digested === 0, '12c. digest is idempotent')

  // ── 13. what is LEFT is exactly the set that should still need attention ─
  const left = coord._unseenForTopic(TOPIC).map(m => m.id).sort()
  ok(JSON.stringify(left) === JSON.stringify(
      ['m-bound-no-task', 'm-done-cron-now', 'm-done-dangling-fresh', 'm-done-fresh', 'm-done-running'].sort()),
     '13. final survivors are exactly the five unresolved ones (got ' + left.join(',') + ')')

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch (e) {}
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
