'use strict'

// Unit test for the 2026-08-29 resolved-target inject gate (Co-Exist lane B1
// pass 7). Two defects, both found by pass 6 and both left unfixed.
//
// DEFECT 2, THE IMPORTANT ONE. The landing gate keyed on the ADDRESS FORM, not
// on the tab it resolved to: `landingGated = tgt.kind === 'conductor'`, and
// resolveLiveTargetTab sets kind:'conductor' only inside its isConductor
// branch. Address the SAME conductor tab as `chat.session:<id>.inbox` and
// resolution takes the session branch, returns kind:'session', skips the gate
// entirely, and markSeen CONSUMES the message on an unverified inject. That is
// precisely the defect 9bf3cee was written to kill, reached through a second
// door.
//
// It was dormant, not absent. A worker addressing `conductor` WITH a recorded
// parent_session is rewritten to chat.session:<parent>.inbox; one WITHOUT gets
// body.deliver='queue' and is never injected. No dispatcher records
// parent_session today, so every worker report-back takes the safe queue-only
// path and the session door carries no traffic. The moment parent_session is
// populated - an INTENDED feature with consuming code already in place - every
// report-back routes onto the ungated door. A latent regression armed to fire
// when a feature is completed is invisible to every measurement taken today,
// which is why it is tested here rather than watched for.
//
// DEFECT 1. The landing poll sat INSIDE the serialised _injectChain. The chain
// exists to serialise clipboard and window focus; the poll needs neither. So
// every concurrent caller waited out every earlier caller's full 12s timeout.
// Measured pass 6 at a 2000ms timeout: five concurrent injects finished at
// 2046/4069/6087/8107/10119ms and injectTurn was called five times, because
// _injectAllowedNow is checked at ENQUEUE while _noteInject stamps at DEQUEUE,
// so the per-target rate limit gated nothing.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-inject-gate-resolved-target.test.js

process.env.COORD_DISABLE_SWEEP = '1'
process.env.COORD_INJECT_PER_TARGET_MS = '0'   // several sends at one target
process.env.COORD_INJECT_LANDING_TIMEOUT_MS = '800'
process.env.COORD_INJECT_LANDING_POLL_MS = '50'

const os = require('os')
const path = require('path')
const fs = require('fs')
const assert = require('assert')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-resolved-target-'))
process.env.COORD_ROOT = tmpRoot
for (const d of ['messages', 'inbox', 'workers', 'state', 'conductors', 'chat-tabs']) {
  fs.mkdirSync(path.join(tmpRoot, d), { recursive: true })
}

const coord = require('./coord.js')

// The conductor's registered chat-tab label. "Claude Code" is not arbitrary:
// nine live anchors in COORD_ROOT/chat-tabs carry that exact string, which is
// how a session address comes to point at the conductor's own tab.
const CONDUCTOR_LABEL = 'Claude Code'
const OTHER_LABEL = 'some-other-chat'
const CONDUCTOR_SESSION = 'sess-conductor-0001'
const OTHER_SESSION = 'sess-other-0002'
const CONDUCTOR_TOPIC = 'chat.conductor.inbox'
const CONDUCTOR_SESSION_TOPIC = 'chat.session:' + CONDUCTOR_SESSION + '.inbox'
const OTHER_SESSION_TOPIC = 'chat.session:' + OTHER_SESSION + '.inbox'
const CONDUCTORS_DIR = path.join(tmpRoot, 'conductors')

const TABS = [
  { label: CONDUCTOR_LABEL, viewColumn: 1, index: 0, viewType: 'claude-code' },
  { label: OTHER_LABEL, viewColumn: 1, index: 1, viewType: 'claude-code' },
]

function writeConductor(lastSeenAt, inTurn) {
  const row = {
    tab_id: 'conductor',
    ide: 'stable',
    title_match: CONDUCTOR_LABEL,
    workspace_root: tmpRoot,
    in_turn: !!inTurn,
    in_turn_set_at: null,
    registered_at: '2026-08-29T00:00:00.000Z',
    last_seen_at: lastSeenAt,
  }
  for (const f of ['current.json', 'default.json']) {
    fs.writeFileSync(path.join(CONDUCTORS_DIR, f), JSON.stringify(row), 'utf8')
  }
}

// Anchor a session id onto a live tab, exactly as conductor_heartbeat.py does
// on that chat's own genuine user turn. updated_at is unix SECONDS.
function writeAnchor(sessionId, label, viewColumn, index) {
  fs.writeFileSync(
    path.join(tmpRoot, 'chat-tabs', sessionId + '.json'),
    JSON.stringify({
      session_id: sessionId, label: label, viewColumn: viewColumn, index: index,
      updated_at: Math.floor(Date.now() / 1000),
    }),
    'utf8'
  )
}

function readMessage(id) {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'messages', id + '.json'), 'utf8'))
}

let injectCalls = 0
function stubChatInject(onInject) {
  return {
    listChatTabs: async () => TABS.slice(),
    injectTurn: async (args) => {
      injectCalls++
      if (onInject) await onInject(args)
      return { ok: true, label: args && args.label }
    },
  }
}

async function send(topic, text) {
  return coord.message_chat(
    { to: topic, text: text, from_label: 'resolved-target-test' },
    { tab_id: 'test-sender' }
  )
}

async function main() {
  let failures = 0
  const check = (name, fn) => {
    try { fn(); console.log('  PASS  ' + name) }
    catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
  }

  writeAnchor(CONDUCTOR_SESSION, CONDUCTOR_LABEL, 1, 0)
  writeAnchor(OTHER_SESSION, OTHER_LABEL, 1, 1)

  // ── Case A: the conductor's own tab, reached by its SESSION address ──────
  // Same physical tab as `chat.conductor.inbox`. last_seen_at never moves, so
  // no turn landed. The gate must refuse and leave the message unseen.
  writeConductor('2026-08-29T01:00:00.000Z')
  injectCalls = 0
  coord._setChatInject(stubChatInject(null))
  const a = await send(CONDUCTOR_SESSION_TOPIC, 'case A: session address onto the conductor tab')
  const aMsg = readMessage(a.message_id)

  console.log('\nCase A - conductor tab addressed as chat.session:<id>.inbox, last_seen_at static')
  check('the inject was actually attempted (the door is open)', () => {
    assert.strictEqual(injectCalls, 1, 'injectTurn called ' + injectCalls + ' times')
  })
  check('delivery is NOT reported ok', () => {
    assert.strictEqual(a.delivery && a.delivery.ok, false, 'delivery was ' + JSON.stringify(a.delivery))
  })
  check("reason is 'submit_did_not_land'", () => {
    assert.strictEqual(a.delivery.reason, 'submit_did_not_land')
  })
  check('message is LEFT UNSEEN so the inbox still serves it', () => {
    assert.strictEqual(aMsg.seen_at, null, 'seen_at was ' + aMsg.seen_at)
  })

  // ── Case B: same address, a turn genuinely lands ─────────────────────────
  writeConductor('2026-08-29T02:00:00.000Z')
  injectCalls = 0
  coord._setChatInject(stubChatInject(async () => { writeConductor('2026-08-29T02:00:05.000Z') }))
  const b = await send(CONDUCTOR_SESSION_TOPIC, 'case B: session address, a real turn lands')
  const bMsg = readMessage(b.message_id)

  console.log('\nCase B - same session address, last_seen_at advances')
  check('delivery is reported ok', () => {
    assert.strictEqual(b.delivery.ok, true, 'delivery was ' + JSON.stringify(b.delivery))
  })
  check('landing is asserted explicitly', () => { assert.strictEqual(b.delivery.landed, true) })
  check('message IS marked seen', () => { assert.ok(bMsg.seen_at, 'seen_at was null on a landed turn') })

  // ── Case C: a genuinely different chat is NOT newly gated ────────────────
  // The gate must key on the resolved tab, so a session tab that is not the
  // conductor's keeps prior behaviour exactly: no landing observable exists for
  // it, so it is consumed on inject as before.
  writeConductor('2026-08-29T03:00:00.000Z')
  injectCalls = 0
  coord._setChatInject(stubChatInject(null))
  const c = await send(OTHER_SESSION_TOPIC, 'case C: an ordinary session chat')
  const cMsg = readMessage(c.message_id)

  console.log('\nCase C - an ordinary session tab (not the conductor), last_seen_at static')
  check('delivery is ok (prior behaviour preserved)', () => {
    assert.strictEqual(c.delivery.ok, true, 'delivery was ' + JSON.stringify(c.delivery))
  })
  check('landing is not asserted either way', () => { assert.strictEqual(c.delivery.landed, null) })
  check('message IS marked seen, as before', () => { assert.ok(cMsg.seen_at) })

  // ── Case D: the landing poll no longer blocks the inject chain ───────────
  // A conductor send that will poll to its full timeout, and an unrelated
  // session send fired 100ms later. The poll needs neither clipboard nor focus,
  // so the second send must not wait behind it.
  writeConductor('2026-08-29T04:00:00.000Z')
  injectCalls = 0
  coord._setChatInject(stubChatInject(null))
  const t0 = Date.now()
  const slow = send(CONDUCTOR_TOPIC, 'case D: conductor send that polls to timeout')
  await new Promise((r) => setTimeout(r, 100))
  const fastStart = Date.now()
  await send(OTHER_SESSION_TOPIC, 'case D: unrelated chat behind it')
  const fastMs = Date.now() - fastStart
  await slow
  const slowMs = Date.now() - t0

  console.log('\nCase D - unrelated send behind a conductor landing poll')
  console.log('        unrelated send took ' + fastMs + 'ms; conductor send took ' + slowMs + 'ms')
  check('the conductor send really did poll to timeout', () => {
    assert.ok(slowMs >= 800, 'conductor send returned in ' + slowMs + 'ms, it cannot have polled')
  })
  check('the unrelated send does NOT wait out that poll', () => {
    assert.ok(fastMs < 400, 'unrelated send took ' + fastMs + 'ms, it queued behind the poll')
  })

  // ── Case E: a concurrent burst does not serialise N full timeouts ────────
  // Pass 6 measured five concurrent injects finishing at 2046/4069/6087/8107/
  // 10119ms with injectTurn called five times. One conductor landing poll is in
  // flight at a time; the rest stay inbox-queued rather than stacking.
  writeConductor('2026-08-29T05:00:00.000Z')
  injectCalls = 0
  coord._setChatInject(stubChatInject(null))
  const tBurst = Date.now()
  const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => send(CONDUCTOR_TOPIC, 'case E burst ' + n)))
  const burstMs = Date.now() - tBurst
  const attempted = burst.filter((r) => r.delivery && r.delivery.attempted !== false).length

  console.log('\nCase E - five concurrent conductor sends')
  console.log('        total ' + burstMs + 'ms, injectTurn calls=' + injectCalls + ', attempted=' + attempted)
  check('only ONE inject is attempted, the rest stay queued', () => {
    assert.strictEqual(injectCalls, 1, 'injectTurn called ' + injectCalls + ' times')
  })
  check('the burst costs one timeout, not five', () => {
    assert.ok(burstMs < 1800, 'burst took ' + burstMs + 'ms (five serialised timeouts would be ~4000ms)')
  })
  check('every refused message is left unseen for the durable inbox', () => {
    const unseen = burst.filter((r) => readMessage(r.message_id).seen_at == null).length
    assert.strictEqual(unseen, 5, 'only ' + unseen + ' of 5 left unseen')
  })

  console.log('\n' + (failures === 0
    ? 'ALL PASS - the gate keys on the resolved tab, and the poll is off the chain.'
    : failures + ' FAILURE(S)'))
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
