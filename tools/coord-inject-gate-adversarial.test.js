'use strict'

// Co-Exist lane B1 pass 8. INDEPENDENT adversarial suite against the pass 7
// resolved-target inject gate (bd62b07d). Pass 7 wrote its own tests to pass;
// this file is written to BREAK the fix, and every case here is one pass 7 did
// not write.
//
// The thing under attack is _tabIsConductorTab plus the new global
// _conductorLandingInFlight flag. Pass 7's own comment claims the predicate
// "uses exactly the identity the conductor branch below accepts". These cases
// test that claim rather than trusting it.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-inject-gate-adversarial.test.js

process.env.COORD_DISABLE_SWEEP = '1'
process.env.COORD_INJECT_PER_TARGET_MS = '0'
process.env.COORD_INJECT_LANDING_TIMEOUT_MS = '700'
process.env.COORD_INJECT_LANDING_POLL_MS = '40'

const os = require('os')
const path = require('path')
const fs = require('fs')
const assert = require('assert')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-adversarial-'))
process.env.COORD_ROOT = tmpRoot
for (const d of ['messages', 'inbox', 'workers', 'state', 'conductors', 'chat-tabs']) {
  fs.mkdirSync(path.join(tmpRoot, d), { recursive: true })
}

const coord = require('./coord.js')
const CONDUCTORS_DIR = path.join(tmpRoot, 'conductors')
const TABS_DIR = path.join(tmpRoot, 'chat-tabs')

let TABS = []
let injectCalls = 0
let injectLog = []

function setTabs(list) { TABS = list.slice() }

function writeConductor(opts) {
  const row = {
    tab_id: opts.tab_id || 'conductor',
    ide: 'stable',
    title_match: Object.prototype.hasOwnProperty.call(opts, 'title_match') ? opts.title_match : 'Claude Code',
    title_fingerprint: opts.title_fingerprint || null,
    workspace_root: tmpRoot,
    in_turn: !!opts.in_turn,
    in_turn_set_at: null,
    registered_at: '2026-08-29T00:00:00.000Z',
    last_seen_at: opts.last_seen_at || '2026-08-29T01:00:00.000Z',
  }
  for (const f of ['current.json', 'default.json']) {
    fs.writeFileSync(path.join(CONDUCTORS_DIR, f), JSON.stringify(row), 'utf8')
  }
}

function clearAnchors() {
  for (const f of fs.readdirSync(TABS_DIR)) { try { fs.unlinkSync(path.join(TABS_DIR, f)) } catch (e) {} }
}

function writeAnchor(sessionId, label, viewColumn, index, ageSec) {
  fs.writeFileSync(path.join(TABS_DIR, sessionId + '.json'), JSON.stringify({
    session_id: sessionId, label: label, viewColumn: viewColumn, index: index,
    updated_at: Math.floor(Date.now() / 1000) - (ageSec || 0),
  }), 'utf8')
}

function readMessage(id) {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'messages', id + '.json'), 'utf8'))
}

// onInject(args) may return a promise; it runs INSIDE injectTurn so a test can
// hold the keystroke open or throw from it.
function stubChatInject(onInject) {
  coord._setChatInject({
    listChatTabs: async () => TABS.slice(),
    injectTurn: async (args) => {
      injectCalls++
      injectLog.push(args && args.label)
      if (onInject) await onInject(args)
      return { ok: true, label: args && args.label }
    },
  })
}

function reset() { injectCalls = 0; injectLog = [] }

async function send(topic, text) {
  return coord.message_chat({ to: topic, text: text, from_label: 'pass8-adversarial' }, { tab_id: 'test-sender' })
}

const SESS_COND = 'sess-conductor-aaaa'
const SESS_IMP = 'sess-impostor-bbbb'
const SESS_PLAIN = 'sess-plain-cccc'
const T_COND = 'chat.session:' + SESS_COND + '.inbox'
const T_IMP = 'chat.session:' + SESS_IMP + '.inbox'
const T_PLAIN = 'chat.session:' + SESS_PLAIN + '.inbox'
const T_CONDUCTOR = 'chat.conductor.inbox'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}
const note = (name, fn) => {
  try { fn(); console.log('  OBSERVED  ' + name) }
  catch (e) { console.log('  NOT-OBSERVED  ' + name + '\n        ' + e.message) }
}

async function main() {

  // CASE F. The conductor addressed by its OWN tab_id while a session-address
  // landing poll on the SAME physical tab is in flight. Both addresses reach one
  // tab; the second must not walk past the in-flight guard.
  console.log('\nCASE F  conductor tab_id address arrives during a session-address poll')
  clearAnchors(); reset()
  setTabs([{ label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' }])
  writeConductor({ tab_id: 'tabcond1', title_match: 'Claude Code', last_seen_at: '2026-08-29T01:00:00.000Z' })
  writeAnchor(SESS_COND, 'Claude Code', 1, 0)
  stubChatInject(null)
  const fSlow = send(T_COND, 'F: session address onto the conductor tab, will poll to timeout')
  await new Promise((r) => setTimeout(r, 80))
  const fSecond = await send('chat.tabcond1.inbox', 'F: same tab, reached by tab_id, mid-poll')
  const fSlowR = await fSlow
  check('the session-addressed send WAS landing-gated (it polled and did not land)', () => {
    assert.strictEqual(fSlowR.delivery.reason, 'submit_did_not_land', JSON.stringify(fSlowR.delivery))
  })
  check('the tab_id-addressed send is REFUSED while that poll is in flight', () => {
    assert.strictEqual(fSecond.delivery.attempted, false, JSON.stringify(fSecond.delivery))
    assert.strictEqual(fSecond.delivery.reason, 'conductor_landing_in_flight', JSON.stringify(fSecond.delivery))
  })
  check('only ONE injectTurn fired for the two sends', () => {
    assert.strictEqual(injectCalls, 1, 'injectTurn called ' + injectCalls)
  })
  check('both messages are left UNSEEN for the durable inbox', () => {
    assert.strictEqual(readMessage(fSlowR.message_id).seen_at, null, 'slow was consumed')
    assert.strictEqual(readMessage(fSecond.message_id).seen_at, null, 'second was consumed')
  })

  // CASE G1. title_match ABSENT. The predicate must not match on label.
  console.log('\nCASE G1  conductor registration with NO title_match')
  clearAnchors(); reset()
  setTabs([{ label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' }])
  writeConductor({ title_match: '', last_seen_at: '2026-08-29T02:00:00.000Z' })
  writeAnchor(SESS_COND, 'Claude Code', 1, 0)
  stubChatInject(null)
  const g1 = await send(T_COND, 'G1: no title_match on the registration')
  check('the predicate does NOT match, so the send is not landing-gated', () => {
    assert.strictEqual(g1.delivery.ok, true, JSON.stringify(g1.delivery))
    assert.strictEqual(g1.delivery.landed, null, JSON.stringify(g1.delivery))
  })
  note('CONSEQUENCE: with no title_match the conductor tab is consumed unverified', () => {
    assert.ok(readMessage(g1.message_id).seen_at, 'message was left unseen')
  })

  // CASE G2. title_match is a WINDOW-TITLE sentinel "[...]" and not a chat label.
  console.log('\nCASE G2  title_match is a "[...]" sentinel, not a chat-tab label')
  clearAnchors(); reset()
  setTabs([{ label: '[Some Window Title]', viewColumn: 1, index: 0, viewType: 'claude-code' }])
  writeConductor({ title_match: '[Some Window Title]', last_seen_at: '2026-08-29T03:00:00.000Z' })
  writeAnchor(SESS_COND, '[Some Window Title]', 1, 0)
  stubChatInject(null)
  const g2 = await send(T_COND, 'G2: sentinel title_match')
  check('a "[...]" sentinel is NOT accepted as a label match', () => {
    assert.strictEqual(g2.delivery.ok, true, JSON.stringify(g2.delivery))
    assert.strictEqual(g2.delivery.landed, null, JSON.stringify(g2.delivery))
  })

  // CASE H. Fingerprint-only: no usable title_match, a fingerprint that the live
  // label clears. The predicate must still recognise the conductor tab.
  console.log('\nCASE H  fingerprint-only match, no exact label')
  clearAnchors(); reset()
  setTabs([{ label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' }])
  writeConductor({
    title_match: '[not-a-chat-label]',
    title_fingerprint: { v: 1, tokens: ['claude', 'code', 'autonomy', 'sweep'] },
    last_seen_at: '2026-08-29T04:00:00.000Z',
  })
  writeAnchor(SESS_COND, 'Claude Code', 1, 0)
  stubChatInject(null)
  const h = await send(T_COND, 'H: fingerprint-only conductor identity')
  check('the fingerprint leg DOES gate the send (no exact label needed)', () => {
    assert.strictEqual(h.delivery.reason, 'submit_did_not_land', JSON.stringify(h.delivery))
    assert.strictEqual(readMessage(h.message_id).seen_at, null, 'message was consumed')
  })

  // CASE I. Two concurrent injects at DIFFERENT targets, only one the conductor.
  // The non-conductor must not be blocked by the global in-flight flag.
  console.log('\nCASE I  a non-conductor target during a conductor landing poll')
  clearAnchors(); reset()
  setTabs([
    { label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' },
    { label: 'ordinary chat', viewColumn: 1, index: 1, viewType: 'claude-code' },
  ])
  writeConductor({ title_match: 'Claude Code', last_seen_at: '2026-08-29T05:00:00.000Z' })
  writeAnchor(SESS_PLAIN, 'ordinary chat', 1, 1)
  stubChatInject(null)
  const iSlow = send(T_CONDUCTOR, 'I: conductor send that polls to timeout')
  await new Promise((r) => setTimeout(r, 80))
  const iStart = Date.now()
  const iFast = await send(T_PLAIN, 'I: unrelated chat during that poll')
  const iFastMs = Date.now() - iStart
  await iSlow
  check('the unrelated target is NOT refused with conductor_landing_in_flight', () => {
    assert.notStrictEqual(iFast.delivery.reason, 'conductor_landing_in_flight', JSON.stringify(iFast.delivery))
    assert.strictEqual(iFast.delivery.ok, true, JSON.stringify(iFast.delivery))
  })
  check('and it does not wait out the conductor poll', () => {
    assert.ok(iFastMs < 350, 'unrelated send took ' + iFastMs + 'ms')
  })
  check('both tabs really were injected', () => {
    assert.strictEqual(injectCalls, 2, 'injectTurn called ' + injectCalls + ' times: ' + JSON.stringify(injectLog))
  })

  // CASE J. injectTurn THROWS mid-flight. Does _conductorLandingInFlight wedge
  // every later conductor inject? Pass 7 reasoned it could not; this measures it.
  console.log('\nCASE J  injectTurn throws, then a later conductor inject')
  clearAnchors(); reset()
  setTabs([{ label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' }])
  writeConductor({ title_match: 'Claude Code', last_seen_at: '2026-08-29T06:00:00.000Z' })
  stubChatInject(async () => { throw new Error('simulated bridge failure mid-inject') })
  const j1 = await send(T_CONDUCTOR, 'J: this inject throws')
  check('the throw is reported, not swallowed', () => {
    assert.strictEqual(j1.delivery.ok, false, JSON.stringify(j1.delivery))
    assert.strictEqual(j1.delivery.reason, 'inject_threw', JSON.stringify(j1.delivery))
  })
  check('a thrown inject leaves the message UNSEEN', () => {
    assert.strictEqual(readMessage(j1.message_id).seen_at, null)
  })
  reset()
  stubChatInject(async () => { writeConductor({ title_match: 'Claude Code', last_seen_at: '2026-08-29T06:00:09.000Z' }) })
  const j2 = await send(T_CONDUCTOR, 'J: the next conductor send must not be wedged')
  check('the in-flight flag is NOT stuck true after a throw', () => {
    assert.notStrictEqual(j2.delivery.reason, 'conductor_landing_in_flight', JSON.stringify(j2.delivery))
    assert.strictEqual(j2.delivery.ok, true, JSON.stringify(j2.delivery))
    assert.strictEqual(j2.delivery.landed, true, JSON.stringify(j2.delivery))
  })

  // CASE J2. A landing poll that TIMES OUT must also clear the flag.
  console.log('\nCASE J2  a timed-out landing poll clears the flag')
  clearAnchors(); reset()
  setTabs([{ label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' }])
  writeConductor({ title_match: 'Claude Code', last_seen_at: '2026-08-29T07:00:00.000Z' })
  stubChatInject(null)
  const j2a = await send(T_CONDUCTOR, 'J2: polls to timeout')
  reset()
  stubChatInject(async () => { writeConductor({ title_match: 'Claude Code', last_seen_at: '2026-08-29T07:00:09.000Z' }) })
  const j2b = await send(T_CONDUCTOR, 'J2: must still be attempted afterwards')
  check('the first send timed out', () => {
    assert.strictEqual(j2a.delivery.reason, 'submit_did_not_land', JSON.stringify(j2a.delivery))
  })
  check('the finally cleared the flag, so the next send lands', () => {
    assert.strictEqual(j2b.delivery.ok, true, JSON.stringify(j2b.delivery))
    assert.strictEqual(j2b.delivery.landed, true, JSON.stringify(j2b.delivery))
  })

  // CASE K. THE NEW FINDING. A NON-conductor chat wearing the conductor's
  // registered label. _tabIsConductorTab has no uniqueness gate and no
  // worker/pool comparison on its label leg, so that chat is is_conductor_tab.
  // It then holds the GLOBAL _conductorLandingInFlight flag for a full landing
  // timeout, and every genuine conductor inject in that window is refused.
  console.log('\nCASE K  an impostor chat wearing the conductor label holds the global flag')
  clearAnchors(); reset()
  setTabs([
    { label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' },  // the real conductor tab
    { label: 'Claude Code', viewColumn: 2, index: 0, viewType: 'claude-code' },  // an unrelated chat, same label
  ])
  writeConductor({ title_match: 'Claude Code', last_seen_at: '2026-08-29T08:00:00.000Z' })
  // ONLY the impostor is freshly anchored, so the labelShared guard has no live
  // peer to compare against. A quiet conductor is exactly the away-window case.
  writeAnchor(SESS_IMP, 'Claude Code', 2, 0)
  stubChatInject(null)
  const kSlow = send(T_IMP, 'K: impostor chat, session-addressed')
  await new Promise((r) => setTimeout(r, 80))
  const kCond = await send(T_CONDUCTOR, 'K: a genuine conductor message during that window')
  const kSlowR = await kSlow
  note('an unrelated chat IS treated as the conductor (false positive, by design)', () => {
    assert.strictEqual(kSlowR.delivery.reason, 'submit_did_not_land', JSON.stringify(kSlowR.delivery))
  })
  note('CONSEQUENCE: a genuine conductor message is REFUSED behind it', () => {
    assert.strictEqual(kCond.delivery.reason, 'conductor_landing_in_flight', JSON.stringify(kCond.delivery))
  })
  check('the genuine conductor message is at least left UNSEEN, not lost', () => {
    assert.strictEqual(readMessage(kCond.message_id).seen_at, null, 'conductor message was consumed')
  })

  // CASE K2. THE SHARPENED VERSION OF K, and the one that bites. The impostor
  // does NOT share the conductor's exact label, so the conductor branch still
  // resolves cleanly by exact label. The impostor is classified as the conductor
  // by the FINGERPRINT leg alone, which _tabIsConductorTab calls with a
  // one-element array and so never reaches pickByFingerprint's uniqueness gate.
  // The live registration carries title_fingerprint tokens ["claude","code"],
  // so any chat auto-titled with both of those and little else clears the bar.
  console.log('\nCASE K2  a fingerprint-only impostor blocks the genuine conductor')
  clearAnchors(); reset()
  setTabs([
    { label: 'Claude Code', viewColumn: 1, index: 0, viewType: 'claude-code' },      // real conductor tab, unique label
    { label: 'claude code review', viewColumn: 2, index: 0, viewType: 'claude-code' }, // impostor, different label
  ])
  writeConductor({
    title_match: 'Claude Code',
    title_fingerprint: { v: 1, tokens: ['claude', 'code'] },   // the LIVE fingerprint, verbatim
    last_seen_at: '2026-08-29T09:00:00.000Z',
  })
  writeAnchor(SESS_IMP, 'claude code review', 2, 0)
  stubChatInject(null)
  const k2Slow = send(T_IMP, 'K2: impostor chat, session-addressed')
  await new Promise((r) => setTimeout(r, 80))
  const k2Cond = await send(T_CONDUCTOR, 'K2: a genuine conductor message during that window')
  const k2SlowR = await k2Slow
  note('the impostor is classified as the conductor by the fingerprint leg', () => {
    assert.strictEqual(k2SlowR.delivery.reason, 'submit_did_not_land', JSON.stringify(k2SlowR.delivery))
  })
  note('CONSEQUENCE: the genuine conductor inject is REFUSED behind it', () => {
    assert.strictEqual(k2Cond.delivery.reason, 'conductor_landing_in_flight', JSON.stringify(k2Cond.delivery))
    assert.strictEqual(k2Cond.delivery.attempted, false, JSON.stringify(k2Cond.delivery))
  })
  check('the refused conductor message is left UNSEEN, so it is delayed not lost', () => {
    assert.strictEqual(readMessage(k2Cond.message_id).seen_at, null, 'conductor message was consumed')
  })
  check('only the impostor was actually injected', () => {
    assert.strictEqual(injectCalls, 1, 'injectTurn called ' + injectCalls + ': ' + JSON.stringify(injectLog))
    assert.strictEqual(injectLog[0], 'claude code review', JSON.stringify(injectLog))
  })

  // CASE L. The fingerprint leg is called with a SINGLE-element array, so
  // pickByFingerprint's strict-uniqueness branch (scored.length > 1) can never
  // run. The conductor branch calls it with the whole pool and gets that gate.
  // So the predicate accepts tabs the conductor branch would refuse outright.
  console.log('\nCASE L  the fingerprint leg has no uniqueness gate')
  const ttm = require('./tab-title-match')
  const fp = { v: 1, tokens: ['claude', 'code', 'autonomy', 'sweep'] }
  const tabA = { label: 'Claude Code', viewColumn: 1, index: 0 }
  const tabB = { label: 'Autonomy Sweep', viewColumn: 2, index: 0 }
  const poolPick = ttm.pickByFingerprint([tabA, tabB], fp, null)
  const soloPickA = ttm.pickByFingerprint([tabA], fp, null)
  const soloPickB = ttm.pickByFingerprint([tabB], fp, null)
  check('against the WHOLE pool the fingerprint is refused as ambiguous', () => {
    assert.strictEqual(poolPick.match, null, 'pool pick matched: ' + poolPick.reason)
  })
  note('but each tab ALONE clears the bar, which is how _tabIsConductorTab calls it', () => {
    assert.ok(soloPickA.match, 'tabA solo: ' + soloPickA.reason)
    assert.ok(soloPickB.match, 'tabB solo: ' + soloPickB.reason)
  })

  console.log('\n' + (failures === 0
    ? 'ALL PASS - the pass 7 gate holds against every adversarial case; see OBSERVED lines for residuals.'
    : failures + ' FAILURE(S)'))
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
