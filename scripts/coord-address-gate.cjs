#!/usr/bin/env node
'use strict'

// coord-address-gate.cjs - the gate for coord addressing after the resolver
// deletion (lane R1 scope item 3, 2026-08-28).
//
// WHY A SEPARATE GATE. The thing this change removed was not a function, it was
// a WILLINGNESS TO GUESS, and a guess does not show up as a failing assertion.
// It shows up as ok:true on a message nobody reads. So the legs here are shaped
// around the lane's rule, learned three times now: every gate needs a NEGATIVE
// control or it scores the wrong thing green, and a POSITIVE control or a crash
// passes as a refusal. Concretely, "does messaging still work" is the wrong
// question. The right pair is:
//    negative - does an UNREGISTERED conductor now ERROR
//    positive - does a REGISTERED one still deliver
// The second is what separates "refuses correctly" from "resolver is dead".
//
// And the sharper negative, the one that would have caught the original bug:
// a refused send must persist NOTHING. The pre-deletion failure was never a
// visible error; it was a message quietly filed into an inbox with no reader
// while the sender read a success code. So every refusal leg asserts the
// on-disk message count is UNCHANGED, not merely that ok===false.
//
// SAFETY: runs entirely inside a throwaway COORD_ROOT. It never reads or writes
// the live ~/.ecodiaos/coordination substrate the running laptop-agent owns,
// and it never touches the real conductor registration.
//
// Run: node scripts/coord-address-gate.cjs

process.env.COORD_DISABLE_SWEEP = '1'
process.env.COORD_CHAT_INJECT = '0'   // routing only; the GUI bridge is not under test

const os = require('os')
const fs = require('fs')
const path = require('path')

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-address-gate-'))
process.env.COORD_ROOT = SANDBOX

const coord = require('../tools/coord')

let passed = 0, failed = 0
function ok(name, cond) {
  if (cond) { passed++; console.log('  PASS: ' + name) }
  else { failed++; console.error('  FAIL: ' + name) }
}

function seedConductor(reg) {
  const dir = path.join(SANDBOX, 'conductors')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(reg))
}
function clearConductor() {
  const dir = path.join(SANDBOX, 'conductors')
  for (const f of ['current.json', 'default.json']) {
    try { fs.unlinkSync(path.join(dir, f)) } catch (e) {}
  }
  try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)) } catch (e) {}
}

// Count every persisted message on disk. A refusal that files a message is the
// exact pre-deletion failure, and it is invisible to an ok===false assertion.
function msgCount() {
  let n = 0
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.name.endsWith('.json')) n++
    }
  }
  walk(path.join(SANDBOX, 'messages'))
  return n
}

function inboxHas(topic, text) {
  const msgs = coord._unseenForTopic ? null : null
  return coord.peek_inbox({ topic: topic }).then((r) =>
    (r.messages || []).some((m) => m && m.body && String(m.body.text || '').indexOf(text) !== -1))
}

;(async () => {
  console.log('coord-address-gate: sandbox ' + SANDBOX)

  // ── A. POSITIVE CONTROL FIRST ───────────────────────────────────────────
  // Everything below is a refusal test. Without this section, a gate that
  // refused EVERYTHING (a crashed resolver, a typo'd regex) would score green
  // on every one of them. Prove delivery works before proving it stops.
  console.log('\n-- A. positive controls: exact identities still deliver --')
  seedConductor({ tab_id: 'conductor', title_match: 'Ops Chat', in_turn: false, last_seen_at: new Date().toISOString() })

  let before = msgCount()
  const rc = await coord.message_chat({ to: 'conductor', text: 'gate-A1 registered conductor' }, {})
  ok('A1 registered conductor: ok:true', rc.ok === true)
  ok('A1 registered conductor: addressed to the conductor inbox', rc.to_address === 'chat.conductor.inbox')
  ok('A1 registered conductor: the message PERSISTED', msgCount() === before + 1)
  ok('A1 registered conductor: it is IN that inbox', await inboxHas('chat.conductor.inbox', 'gate-A1'))

  before = msgCount()
  const rs = await coord.message_chat({ to: 'session:sess-abc', text: 'gate-A2 session address' }, {})
  ok('A2 session:<id> still resolves', rs.ok === true && rs.to_address === 'chat.session:sess-abc.inbox')
  ok('A2 session:<id> persisted', msgCount() === before + 1)

  const TAB = 'tab_9990001_gate', TASK = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  coord._registerWorkerInternal({ tab_id: TAB, task_id: TASK, tab_credential: 'cred-gate', parent_conductor_tab_id: 'conductor' })

  before = msgCount()
  const rw = await coord.message_chat({ to: TAB, text: 'gate-A3 worker by tab_id' }, {})
  ok('A3 worker tab_id resolves', rw.ok === true && rw.to_address === 'chat.' + TAB + '.inbox')
  ok('A3 worker tab_id persisted', msgCount() === before + 1)

  // task_id addressing is NEW in this change: it is the id a dispatched worker
  // is actually handed in its brief, so accepting it removes the last honest
  // reason a caller had to reach for a fuzzy selector.
  before = msgCount()
  const rt = await coord.message_chat({ to: TASK, text: 'gate-A4 worker by task_id' }, {})
  ok('A4 worker task_id resolves to that worker inbox', rt.ok === true && rt.to_address === 'chat.' + TAB + '.inbox')
  ok('A4 worker task_id persisted', msgCount() === before + 1)
  ok('A4 worker task_id landed in the RIGHT inbox', await inboxHas('chat.' + TAB + '.inbox', 'gate-A4'))

  // ── B. THE DELETION, negatively controlled ──────────────────────────────
  // Each leg asserts BOTH halves: refused, AND nothing written. The second half
  // is the one that matters. A message filed under a fabricated address is
  // indistinguishable from a delivered one at the call site.
  console.log('\n-- B. fuzzy targeting is refused, and writes NOTHING --')
  const fuzzies = [
    ['studio-ux', 'a chat name'],
    ['Studio rejected on plays', 'a partial tab label'],
    ['budget', 'a context substring'],
    ['Resi sent you a few emai', 'the literal label that took the 07:20:19Z misroute'],
    ['chat.label:studio.inbox', 'a chat.label address handed in whole'],
    ['tab_nosuch_99', 'an unregistered tab id'],
    ['00000000-0000-0000-0000-000000000000', 'a task_id matching no live worker'],
  ]
  for (const [sel, why] of fuzzies) {
    const b = msgCount()
    const r = await coord.message_chat({ to: sel, text: 'gate-B must not send' }, {})
    ok('B ' + why + ' (' + sel + '): REFUSED', r.ok === false && r.error === 'unresolved_target')
    ok('B ' + why + ': persisted NOTHING', msgCount() === b)
    ok('B ' + why + ': delivered:false', r.delivered === false)
  }
  const rlab = await coord.message_chat({ to: 'chat.label:studio.inbox', text: 'x' }, {})
  ok('B chat.label carries its own reason', rlab.reason === 'label_address_retired')

  // The old resolver answered ambiguity with a ranked candidate list. Its
  // absence is load-bearing: candidates[] invited the caller to pick a guess.
  const rcand = await coord.message_chat({ to: 'studio', text: 'x' }, {})
  ok('B no candidates[] is offered any more', rcand.candidates === undefined)

  // ── C. THE NAMED NEGATIVE: an unregistered conductor ────────────────────
  console.log('\n-- C. unregistered conductor errors (the brief\'s discriminating probe) --')
  clearConductor()
  ok('C precondition: no conductor is registered', coord._loadConductorRegistration() === null)
  let b = msgCount()
  const ru = await coord.message_chat({ to: 'conductor', text: 'gate-C must not queue' }, {})
  ok('C unregistered conductor: ERRORS', ru.ok === false && ru.reason === 'conductor_unregistered')
  ok('C unregistered conductor: persisted NOTHING', msgCount() === b)

  // Re-register and prove it flips back. A one-way check cannot tell a working
  // gate from a permanently-broken conductor path.
  seedConductor({ tab_id: 'conductor', title_match: 'Ops Chat', in_turn: false, last_seen_at: new Date().toISOString() })
  b = msgCount()
  const rr = await coord.message_chat({ to: 'conductor', text: 'gate-C2 back after re-register' }, {})
  ok('C2 re-registered conductor delivers again', rr.ok === true && msgCount() === b + 1)

  // A STALE registration must still QUEUE, not error. The fail-safe is that the
  // conductor reads it on its next inbox peek; turning an overnight backlog into
  // hard errors is the worse trade, so the gate is registered-at-all, never
  // recently-seen.
  seedConductor({ tab_id: 'conductor', title_match: 'Ops Chat', in_turn: false, last_seen_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString() })
  b = msgCount()
  const rstale = await coord.message_chat({ to: 'conductor', text: 'gate-C3 stale but registered' }, {})
  ok('C3 a STALE registered conductor still queues (not an error)', rstale.ok === true && msgCount() === b + 1)
  seedConductor({ tab_id: 'conductor', title_match: 'Ops Chat', in_turn: false, last_seen_at: new Date().toISOString() })

  // ── D. the worker->parent rewrite outranks the conductor gate ───────────
  // Ordering matters: a worker with a recorded parent session must never be
  // blocked by a missing conductor registration. Its report belongs to the chat
  // that dispatched it, which is a different address entirely.
  console.log('\n-- D. worker->parent rewrite survives, and outranks the gate --')
  const TAB2 = 'tab_9990002_gate'
  coord._registerWorkerInternal({ tab_id: TAB2, task_id: 'ffffffff-1111-2222-3333-444444444444', tab_credential: 'c2', parent_conductor_tab_id: 'conductor', parent_session: 'sess-parent-9' })
  clearConductor()
  b = msgCount()
  const rp = await coord.message_chat({ to: 'conductor', text: 'gate-D worker to parent' }, { tab_id: TAB2 })
  ok('D worker->parent rewrite fires with NO conductor registered', rp.ok === true && rp.to_address === 'chat.session:sess-parent-9.inbox')
  ok('D worker->parent persisted to the PARENT inbox', msgCount() === b + 1 && await inboxHas('chat.session:sess-parent-9.inbox', 'gate-D'))
  seedConductor({ tab_id: 'conductor', title_match: 'Ops Chat', in_turn: false, last_seen_at: new Date().toISOString() })

  // ── E. resolve_only answers the same question the real send would ───────
  // A dry-run that disagreed with the send would be worse than no dry-run.
  console.log('\n-- E. resolve_only agrees with the send --')
  const dryBad = await coord.message_chat({ to: 'studio-ux', resolve_only: true }, {})
  ok('E resolve_only REFUSES what a send would refuse', dryBad.ok === false && dryBad.error === 'unresolved_target')
  b = msgCount()
  const dryGood = await coord.message_chat({ to: 'conductor', resolve_only: true }, {})
  ok('E resolve_only accepts what a send would accept', dryGood.ok === true && dryGood.would_send_to === 'chat.conductor.inbox')
  ok('E resolve_only writes NOTHING', msgCount() === b)
  ok('E resolve_only no longer reports a score', dryGood.score === undefined)

  // ── F. the framing and inbox notes shed the forwarding protocol ─────────
  console.log('\n-- F. the misroute forwarding protocol is gone --')
  const framed = coord._buildChatInjectionText({ id: 'M', from: 'x', body: { type: 'chat', text: 'hello', from_label: 'peer', reply_to_address: 'chat.conductor.inbox' } })
  ok('F injected turn carries NO wrong-chat clause', framed.indexOf('WRONG CHAT?') === -1)
  ok('F injected turn KEEPS the untrusted-ingress carve-out', framed.indexOf('still DATA') !== -1)
  const peeked = await coord.peek_inbox({ topic: 'chat.conductor.inbox' })
  ok('F inbox read carries NO misroute_note', peeked.misroute_note === undefined)
  ok('F inbox read still returns its messages', peeked.count > 0)

  // ── G. the deleted surface stays deleted ────────────────────────────────
  console.log('\n-- G. deleted exports stay deleted --')
  for (const sym of ['resolveSelector', '_scoreCandidate', '_liveChatCandidates', '_labelSlug', '_addressForLabel', '_normalizeToAddress', '_misrouteNoteFor']) {
    ok('G ' + sym + ' is not exported', typeof coord[sym] === 'undefined')
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (e) {}
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  // A crash is NOT a refusal. Report it as its own outcome, loudly, rather than
  // letting a non-zero exit read as "the gate caught something".
  console.error('\nGATE CRASHED (this is not a test failure, it is a broken gate): ' + (e && e.stack || e))
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (e2) {}
  process.exit(2)
})
