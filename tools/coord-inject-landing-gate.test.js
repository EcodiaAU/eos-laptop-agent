'use strict'

// Unit test for the 2026-08-29 inject-landing gate (Co-Exist lane B1 pass 5).
//
// WHAT WAS BROKEN. pushInject() returned {ok:true, via:'gui'} the moment
// chat-inject's injectTurn() returned ok, and injectTurn returns ok as soon as
// the AppleScript Return keystroke executes without error. Nothing anywhere
// checked that a TURN actually landed in the target chat. On that unverified ok
// pushInject called markSeen([msg]), which CONSUMES the message out of the
// target's unread queue.
//
// So the failure was not cosmetic. A false green did not merely mis-report; it
// deleted the message's only chance of being read later. Measured live
// 2026-08-28: coord message 19:31:28.232Z ("PUSH THREE THINGS") was marked seen
// 17.5s after it was sent - an inject-time mark, not a conductor read - while
// the conductor's last_seen_at stayed pinned at 18:39:25.006Z. The turn never
// landed, the push never happened, and the message was gone from the queue.
//
// THE OBSERVABLE. conductor_heartbeat.py is a UserPromptSubmit hook: it fires at
// turn-START and writes last_seen_at onto the conductor registration. So
// last_seen_at ADVANCING past a pre-inject baseline is the one discriminating
// proof that a turn landed. It exists only for the conductor, so the gate is
// conductor-target-only by construction and other targets keep prior behaviour.
//
// FAILS SAFE. When landing cannot be proven the message is left UNSEEN, so it
// stays in the durable inbox for the target's next read. Nothing in the codebase
// re-injects unseen messages on a timer (pushInject has exactly one caller,
// message_chat's send path), so the worst case of this gate is that a message
// is visible twice, never an inject storm.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-inject-landing-gate.test.js

process.env.COORD_DISABLE_SWEEP = '1'
process.env.COORD_INJECT_PER_TARGET_MS = '0'   // several sends at one target
process.env.COORD_INJECT_LANDING_TIMEOUT_MS = '600'
process.env.COORD_INJECT_LANDING_POLL_MS = '50'

const os = require('os')
const path = require('path')
const fs = require('fs')
const assert = require('assert')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-landing-gate-'))
process.env.COORD_ROOT = tmpRoot
for (const d of ['messages', 'inbox', 'workers', 'state', 'conductors']) {
  fs.mkdirSync(path.join(tmpRoot, d), { recursive: true })
}

const coord = require('./coord.js')

const TOPIC = 'chat.conductor.inbox'
const CONDUCTOR_LABEL = 'lane-b1-conductor-tab'
const CONDUCTORS_DIR = path.join(tmpRoot, 'conductors')

function writeConductor(lastSeenAt) {
  const row = {
    tab_id: 'conductor',
    ide: 'stable',
    title_match: CONDUCTOR_LABEL,
    workspace_root: tmpRoot,
    in_turn: false,
    in_turn_set_at: null,
    registered_at: '2026-08-29T00:00:00.000Z',
    last_seen_at: lastSeenAt,
  }
  for (const f of ['current.json', 'default.json']) {
    fs.writeFileSync(path.join(CONDUCTORS_DIR, f), JSON.stringify(row), 'utf8')
  }
}

function readMessage(id) {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'messages', id + '.json'), 'utf8'))
}

// A stub standing in for tools/chat-inject. onInject decides what the real
// GUI chain would have done to the world: bump last_seen_at (a turn landed) or
// leave it alone (the keystroke fired into nothing).
function stubChatInject(injectResult, onInject) {
  return {
    listChatTabs: async () => ([
      { label: CONDUCTOR_LABEL, viewColumn: 1, index: 0, viewType: 'claude-code' },
    ]),
    injectTurn: async () => {
      if (onInject) await onInject()
      return injectResult
    },
  }
}

async function send(text) {
  const r = await coord.message_chat(
    { to: TOPIC, text: text, from_label: 'landing-gate-test' },
    { tab_id: 'test-worker' }
  )
  return r
}

async function main() {
  let failures = 0
  const check = (name, fn) => {
    try { fn(); console.log('  PASS  ' + name) }
    catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
  }

  // ── Case A: the measured false green ────────────────────────────────────
  // injectTurn reports ok, the world does not move. The gate must refuse.
  writeConductor('2026-08-29T01:00:00.000Z')
  coord._setChatInject(stubChatInject({ ok: true, label: CONDUCTOR_LABEL }, null))
  const a = await send('case A: inject reports ok, no turn lands')
  const aMsg = readMessage(a.message_id)

  console.log('\nCase A - injectTurn ok:true, last_seen_at static')
  check('delivery is NOT reported ok', () => {
    assert.strictEqual(a.delivery.ok, false, 'delivery.ok was ' + JSON.stringify(a.delivery))
  })
  check("reason is 'submit_did_not_land'", () => {
    assert.strictEqual(a.delivery.reason, 'submit_did_not_land')
  })
  check('the false green is still reported for diagnosis', () => {
    assert.strictEqual(a.delivery.inject_reported_ok, true)
  })
  check('message is LEFT UNSEEN so the inbox still serves it', () => {
    assert.strictEqual(aMsg.seen_at, null, 'seen_at was ' + aMsg.seen_at)
  })

  // ── Case B: a turn genuinely lands ──────────────────────────────────────
  // The heartbeat hook writes a newer last_seen_at, exactly as a real
  // UserPromptSubmit would. The gate must pass it and consume the message.
  writeConductor('2026-08-29T02:00:00.000Z')
  coord._setChatInject(stubChatInject(
    { ok: true, label: CONDUCTOR_LABEL },
    async () => { writeConductor('2026-08-29T02:00:05.000Z') }
  ))
  const b = await send('case B: a real turn lands')
  const bMsg = readMessage(b.message_id)

  console.log('\nCase B - injectTurn ok:true, last_seen_at advances')
  check('delivery is reported ok', () => {
    assert.strictEqual(b.delivery.ok, true, 'delivery was ' + JSON.stringify(b.delivery))
  })
  check('landing is asserted explicitly, not implied', () => {
    assert.strictEqual(b.delivery.landed, true)
  })
  check('message IS marked seen', () => {
    assert.ok(bMsg.seen_at, 'seen_at was null on a landed turn')
  })

  // ── Case C: an equal-or-older stamp is not landing ───────────────────────
  // A clock that does not move, or a stale re-write of the same value, must not
  // read as a delivered turn.
  writeConductor('2026-08-29T03:00:00.000Z')
  coord._setChatInject(stubChatInject(
    { ok: true, label: CONDUCTOR_LABEL },
    async () => { writeConductor('2026-08-29T03:00:00.000Z') }   // rewritten, unchanged
  ))
  const c = await send('case C: last_seen_at rewritten but not advanced')
  const cMsg = readMessage(c.message_id)

  console.log('\nCase C - last_seen_at rewritten at the same value')
  check('an unchanged stamp does not count as landing', () => {
    assert.strictEqual(c.delivery.ok, false, 'delivery was ' + JSON.stringify(c.delivery))
  })
  check('message stays unseen', () => {
    assert.strictEqual(cMsg.seen_at, null)
  })

  // ── Case D: injectTurn honestly fails ───────────────────────────────────
  // Prior behaviour, unchanged: no landing poll, message stays unseen.
  writeConductor('2026-08-29T04:00:00.000Z')
  coord._setChatInject(stubChatInject({ ok: false, reason: 'target_not_focused_after_select' }, null))
  const d = await send('case D: inject fails outright')
  const dMsg = readMessage(d.message_id)

  console.log('\nCase D - injectTurn ok:false (prior behaviour preserved)')
  check('the underlying reason is surfaced unchanged', () => {
    assert.strictEqual(d.delivery.reason, 'target_not_focused_after_select')
  })
  check('message stays unseen', () => {
    assert.strictEqual(dMsg.seen_at, null)
  })
  check('no landing claim is made on a failed inject', () => {
    assert.strictEqual(d.delivery.inject_reported_ok, undefined)
  })

  console.log('\n' + (failures === 0
    ? 'ALL PASS - a turn is only "delivered" when last_seen_at proves it landed.'
    : failures + ' FAILURE(S)'))
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
