'use strict'
// Failing-first harness for the 2026-08-29 lane_name-at-dispatch wiring
// (status_board ca76cee9, open item (c)).
//
// WHAT WAS BROKEN. inboxTopicFor already resolved a durable LANE mailbox, and
// registerWorkerInternal already stored a lane_name, and routes/comms.js already
// forwarded one. Nothing ever SENT one. Every field in the chain was wired
// except its source, so lane mailboxes existed only for a worker somebody
// registered by hand, and the whole durable-addressing layer was reachable only
// from a test. The row name the lane key is derived from was sitting in scope at
// the dispatch call site the entire time: scheduler.js already builds the tab's
// human-readable worker_name out of row.name three lines above.
//
// THE SECOND HALF, which is the one that bites. Both composeBrief functions
// hardcode inbox="chat.<tab_id>.inbox" into the <dispatched> header. Wire the
// lane without touching them and the brief tells every worker one address while
// the resolver serves another - the exact caller/callee disagreement already
// found and fixed once in routes/comms.js, and worse than either address alone
// because the worker reads the brief and believes it.
//
// Case 1 FAILS pre-fix (no lane_name reaches the dispatcher).
// Case 2 FAILS pre-fix (the header carries the per-tab form for a lane worker).
// Cases 3-5 are the controls: a non-lane row must keep per-tab addressing, the
// conductor topic must be untouched, and the header must never be built by hand.
//
// Run: node tools/dispatch-lane-name-wiring.test.js

const assert = require('assert')

let failures = 0
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}
async function acheck(name, fn) {
  try { await fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}

// ── Case 1: the scheduler must hand the row's own name to the dispatcher ────
//
// Driven through the real exports.dispatchOne against a stub dispatcher, so the
// assertion reads the params the scheduler ACTUALLY sends rather than a
// restatement of them.

const scheduler = require('./scheduler')

let dispatchCalls = []
let updates = []

scheduler._setPool({
  async query(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('UPDATE os_scheduled_tasks')) {
      updates.push({ sql: s, params })
      return { rows: [], rowCount: 1 }
    }
    // Default empty: the austerity guard's SELECT returns no row, which the
    // guard deliberately treats as "not suppressed" and proceeds.
    return { rows: [], rowCount: 0 }
  },
})
scheduler._setCoord({
  async list_workers() { return { workers: [] } },
  async peek_inbox() { return { messages: [] } },
})
scheduler._setDispatcher({
  async dispatch_worker(params) {
    dispatchCalls.push(params)
    // ok:false short-circuits the rest of dispatchOne (bound-wait, tab handle,
    // breaker bookkeeping) which this test does not exercise. The params are
    // already captured, which is the whole assertion.
    return { ok: false, error: 'stub: params captured' }
  },
  async kill_worker() { return { closed: true } },
})
scheduler._setWorktreeFns({
  pruneWorktreeForRow: async () => {},
  allocateWorktreeForRow: async () => null,
})

async function driveDispatch(row) {
  dispatchCalls = []
  try { await scheduler.dispatchOne(row) } catch (e) { /* stub dispatch throws downstream */ }
  return dispatchCalls[0] || null
}

;(async function main() {
  console.log('the scheduler hands the row name to the dispatcher as lane_name:')

  await acheck('a lane-named row passes its full name through', async () => {
    const p = await driveDispatch({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'cowork.daycrew-lane-S2-deploy-verify',
      type: 'delayed',
      prompt: 'do the thing',
      leased_by: 'test',
    })
    assert.ok(p, 'dispatch_worker was never called')
    assert.strictEqual(p.lane_name, 'cowork.daycrew-lane-S2-deploy-verify',
      'lane_name must be the RAW row name (the resolver normalises); got ' + JSON.stringify(p.lane_name))
  })

  await acheck('a non-lane row still passes its name (resolver returns null lane)', async () => {
    const p = await driveDispatch({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'continuity-advance-chain',
      type: 'cron',
      prompt: 'advance',
      leased_by: 'test',
    })
    assert.ok(p, 'dispatch_worker was never called')
    assert.strictEqual(p.lane_name, 'continuity-advance-chain',
      'pass the name unconditionally; laneKeyOf decides, not the caller')
  })

  // ── Case 2: the brief header must carry the RESOLVER's address ────────────
  console.log('\nthe <dispatched> header carries the resolved inbox, not a hand-built one:')

  const macBrief = require('./mac-dispatcher')._composeBrief
  const coworkBrief = require('./cowork')._composeBrief

  const BASE = {
    tab_id: 'tab_TESTAAA',
    task_id: 'task-1',
    tab_credential: 'cred-1',
    parent_conductor_tab_id: 'conductor',
    parent_session: null,
    brief_body: 'body',
    brief_size_bytes: 4,
    brief_storage: 'inline',
    brief_file_path: null,
  }

  for (const [label, compose] of [['mac-dispatcher', macBrief], ['cowork', coworkBrief]]) {
    check(label + ': a supplied lane inbox reaches the header', () => {
      assert.ok(typeof compose === 'function', label + '._composeBrief is not exported')
      const out = compose(Object.assign({}, BASE, { inbox_topic: 'chat.lane.cowork.daycrew-lane-s2.inbox' }))
      assert.ok(out.includes('inbox="chat.lane.cowork.daycrew-lane-s2.inbox"'),
        'header must carry the resolved lane inbox; got: ' + (out.match(/inbox="[^"]*"/) || ['<none>'])[0])
      assert.ok(!out.includes('inbox="chat.tab_TESTAAA.inbox"'),
        'the hardcoded per-tab form must NOT also appear')
    })

    check(label + ': no supplied inbox falls back to the per-tab form (control)', () => {
      const out = compose(Object.assign({}, BASE, { inbox_topic: null }))
      assert.ok(out.includes('inbox="chat.tab_TESTAAA.inbox"'),
        'a worker with no lane must keep the legacy per-tab address')
    })

    check(label + ': the header is never built by hand from tab_id (regression pin)', () => {
      // The literal that caused defect (a) in routes/comms.js. If this string is
      // reconstructed anywhere in the composer, a lane worker gets told the wrong
      // address by the very document it is instructed to trust.
      const out = compose(Object.assign({}, BASE, { inbox_topic: 'chat.lane.cowork.x-lane-a1.inbox' }))
      const attrs = out.match(/inbox="[^"]*"/g) || []
      assert.strictEqual(attrs.length, 1, 'exactly one inbox attribute expected, got ' + attrs.length)
    })
  }

  // ── Case 3: wait_for_inbox finally has a caller, and it is the brief ───────
  //
  // wait_for_inbox shipped with a 600s long-poll and ZERO callers, so a worker's
  // only way to ask a blocking question was to post it and end its turn. This
  // conductor woke to three such questions from tabs that had already closed.
  console.log('\nthe brief teaches the hold, which is what gives wait_for_inbox a caller:')

  for (const [label, compose] of [['mac-dispatcher', macBrief], ['cowork', coworkBrief]]) {
    check(label + ': the brief names coord_wait_for_inbox UNDER the MCP client wall', () => {
      const out = compose(Object.assign({}, BASE, { parent_session: 'sess-9' }))
      assert.ok(out.includes('coord_wait_for_inbox'),
        'no worker will call a tool no brief mentions')
      // THE REGRESSION THIS PINS. The first version of this block said timeout:600,
      // reasoning from coord.js MAX_WAIT_TIMEOUT_S = 600, which is the SERVER cap.
      // The tool's first-ever caller (worker on lane L1, 2026-08-29) proved an MCP
      // CLIENT deadline kills the call between 45s and 60s: 45s returned cleanly at
      // 45075ms, while 60s and 120s both returned a bare transport error with NO
      // envelope. Reproduced independently from the conductor session the same hour.
      // Past that wall a worker loses the tool result AND any message that arrived
      // during the hold, so the documented protocol could never work. Wait longer by
      // LOOPING short holds; never by raising this number.
      const m = out.match(/timeout:\s*(\d+)/)
      assert.ok(m, 'the brief must name an explicit timeout')
      assert.ok(Number(m[1]) <= 45,
        'timeout must be <= 45 (measured MCP client wall is in (45.1s, 60.3s]); got ' + m[1])
      assert.ok(/LOOP|loop/.test(out),
        'a 45s ceiling is only useful if the brief also says to loop it')
    })

    check(label + ': the brief says to read delivered, not ok', () => {
      const out = compose(Object.assign({}, BASE, { parent_session: 'sess-9' }))
      assert.ok(/`delivered`/.test(out) && /NOT `ok`/.test(out),
        'message_chat returns ok:true / delivered:false when the parent cannot be injected into; ' +
        'a worker that checks ok reports asked-and-answered on a message nobody saw')
    })

    check(label + ': the hold targets the dispatching session, never the shared slot', () => {
      // chat.conductor.inbox is ONE slot every chat's turn-start heartbeat
      // overwrites. A worker told to ask "the conductor" posts into whichever
      // chat was typed in most recently (proven misroute 2026-08-28).
      const out = compose(Object.assign({}, BASE, { parent_session: 'sess-9' }))
      assert.ok(out.includes('to:"chat.session:sess-9.inbox"'),
        'the gate question must be addressed to the dispatching session')
    })

    check(label + ': with no parent_session the gate question falls back to conductor', () => {
      const out = compose(Object.assign({}, BASE, { parent_session: null }))
      assert.ok(out.includes('to:"conductor"'),
        'no session known: message_chat rewrites `conductor` for a worker sender')
    })
  }

  // ── Case 4: the conductor path is untouched (three live hooks depend on it) ─
  console.log('\nconductor addressing is untouched:')
  const coord = require('./coord.js')
  check('conductor with a lane_name still resolves to chat.conductor.inbox', () => {
    assert.strictEqual(
      coord._inboxTopicFor({ tab_id: 'conductor', lane_name: 'cowork.daycrew-lane-S2-x' }),
      'chat.conductor.inbox')
  })

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
  process.exit(failures === 0 ? 0 : 1)
})()
