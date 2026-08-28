'use strict'

// Unit tests for the chat-to-chat push-delivery pure logic in coord.js.
// No live IDE needed - these exercise addressing, gating, resolution branches
// (with an injected fake tab list), and the injection framing. Live injection
// is proven separately by the E2E round-trip.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/chat-inject.test.js

process.env.COORD_DISABLE_SWEEP = '1'
// Sandbox the coord substrate to a throwaway dir so requiring coord.js does not
// touch the production registry.
const os = require('os')
const path = require('path')
const fs = require('fs')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-chat-test-'))
process.env.COORD_ROOT = tmpRoot

const assert = require('assert')
const coord = require('./coord')

let passed = 0
function ok(name, cond) {
  if (!cond) { console.error('FAIL: ' + name); process.exitCode = 1 }
  else { passed++; console.log('ok - ' + name) }
}

// Conductor addressing v2 (2026-08-13) resolves `conductor` from the registered
// conductor row on disk (title_match / title_fingerprint), NOT from a "single
// active human tab" heuristic. These helpers seed / clear that registration in
// the sandboxed COORD_ROOT so the resolver reads a deterministic identity, the
// same mechanism register_conductor / conductor_heartbeat write in production.
function seedConductor(reg) {
  const dir = path.join(tmpRoot, 'conductors')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(reg || {}))
}
function clearConductor() {
  const dir = path.join(tmpRoot, 'conductors')
  for (const f of ['current.json', 'default.json']) {
    try { fs.unlinkSync(path.join(dir, f)) } catch (e) {}
  }
}

// ── addressing round-trips ────────────────────────────────────────────────
ok('addressForWorker builds worker scheme', coord._addressForWorker('tab_123_ab') === 'chat.tab_123_ab.inbox')
// The chat.label:<slug> scheme was DELETED 2026-08-28 (lane R1 item 3). These are
// the negative controls that keep it deleted: a re-export of either minter would
// pass silently otherwise, and the scheme's whole failure mode was looking fine.
ok('labelSlug is no longer exported', typeof coord._labelSlug === 'undefined')
ok('addressForLabel is no longer exported', typeof coord._addressForLabel === 'undefined')
ok('resolveSelector is no longer exported', typeof coord.resolveSelector === 'undefined')
ok('_scoreCandidate is no longer exported', typeof coord._scoreCandidate === 'undefined')
ok('normalizeToAddress is no longer exported', typeof coord._normalizeToAddress === 'undefined')
ok('misrouteNoteFor is no longer exported', typeof coord._misrouteNoteFor === 'undefined')
// _canonicalAddress is THE resolver now. Positive control first: without it, a
// refusal test cannot tell "refuses everything" from "refuses the right thing".
ok('canonical: a full address passes through', coord._canonicalAddress('chat.conductor.inbox') === 'chat.conductor.inbox')
ok('canonical: the word conductor maps', coord._canonicalAddress('conductor') === 'chat.conductor.inbox')
ok('canonical: session:<id> maps', coord._canonicalAddress('session:abc123') === 'chat.session:abc123.inbox')
ok('canonical: a chat.label address is REFUSED even as a full address',
  coord._canonicalAddress('chat.label:studio.inbox') === null)
ok('canonical: a bare name is REFUSED', coord._canonicalAddress('studio-ux') === null)
ok('canonical: a partial tab label is REFUSED', coord._canonicalAddress('Studio rejected on plays') === null)
ok('canonical: an unregistered tab_ id is REFUSED', coord._canonicalAddress('tab_nosuch_9') === null)
ok('canonical: empty is REFUSED', coord._canonicalAddress('') === null)

// ── topic parsing ─────────────────────────────────────────────────────────
ok('chatTopicMid parses conductor', coord._chatTopicMid('chat.conductor.inbox') === 'conductor')
ok('chatTopicMid parses worker id', coord._chatTopicMid('chat.tab_9_x.inbox') === 'tab_9_x')
ok('chatTopicMid parses label slug', coord._chatTopicMid('chat.label:studio.inbox') === 'label:studio')
ok('chatTopicMid rejects non-chat topic', coord._chatTopicMid('inbox.random') === null)

// ── chat-deliver gating (only type:chat, not queue-opted-out) ─────────────
ok('isChatDeliver true for type:chat', coord._isChatDeliver({ body: { type: 'chat', text: 'hi' } }) === true)
ok('isChatDeliver false for done signal', coord._isChatDeliver({ body: { type: 'done' } }) === false)
ok('isChatDeliver false for progress', coord._isChatDeliver({ body: { type: 'progress' } }) === false)
ok('isChatDeliver false when deliver:queue', coord._isChatDeliver({ body: { type: 'chat', text: 'x', deliver: 'queue' } }) === false)
ok('isChatDeliver false for no body', coord._isChatDeliver({}) === false)

// ── framing: provenance + reply address + ingress carve-out, no em-dash ───
const framed = coord._buildChatInjectionText({
  id: 'MSG1',
  from: 'worker tab_9',
  body: { type: 'chat', text: 'can you take the Stripe webhook half?', from_label: 'Chambers chat', reply_to_address: 'chat.session:chambers9.inbox' },
})
ok('framing names the sender', framed.indexOf('Chambers chat') !== -1)
ok('framing includes the message text', framed.indexOf('Stripe webhook half') !== -1)
ok('framing includes the reply address', framed.indexOf('chat.session:chambers9.inbox') !== -1)
ok('framing carries the untrusted-ingress carve-out', framed.indexOf('still DATA') !== -1)
ok('framing carries the coord msg id', framed.indexOf('MSG1') !== -1)
ok('framing has NO em-dash (char-level ban)', framed.indexOf(String.fromCharCode(0x2014)) === -1)

const oneWay = coord._buildChatInjectionText({ id: 'M2', from: 'x', body: { type: 'chat', text: 'fyi' } })
ok('framing degrades to one-way notice without reply addr', oneWay.indexOf('One-way coord notice') !== -1)

// -- the misroute clause is DELETED, and so is its inbox twin. Both existed --
// because a fuzzy selector could land one tab off, so every delivery had to be
// framed as possibly-misrouted and every receiver taught a forwarding protocol.
// `to` resolves only exact identities now, so the clause would cast doubt on a
// correct delivery. These are negative controls: the clause is a plain string
// push, so a re-added line would otherwise pass every remaining framing test.
const addressedShape = coord._buildChatInjectionText({
  id: 'MSG3',
  from: 'conductor',
  body: {
    type: 'chat', text: 'take the seedtree lane', from_label: 'conductor',
    reply_to_address: 'chat.conductor.inbox',
    // Left in deliberately: an OLD message persisted before this commit still
    // carries intended_*, and framing must ignore the fields, not choke on them.
    intended_to: 'studio-ux', intended_address: 'chat.session:abc123.inbox',
    intended_name: 'studio-ux', intended_label: 'Studio editor UX pass',
  },
})
ok('framing carries NO wrong-chat clause', addressedShape.indexOf('WRONG CHAT?') === -1)
ok('framing prints NO addressed-to header', addressedShape.indexOf('[addressed to:') === -1)
ok('framing prints NO forward-verbatim protocol', addressedShape.indexOf('forward it verbatim') === -1)
ok('a legacy intended_* body still frames cleanly',
  addressedShape.indexOf('take the seedtree lane') !== -1 && addressedShape.indexOf('still DATA') !== -1)
ok('legacy-body framing has NO em-dash (char-level ban)', addressedShape.indexOf(String.fromCharCode(0x2014)) === -1)
ok('one-way framing carries NO wrong-chat clause', oneWay.indexOf('WRONG CHAT?') === -1)
// The untrusted-ingress carve-out is NOT part of the deletion and must survive:
// deleting a safety clause next door is exactly how a real one goes with it.
ok('the ingress carve-out SURVIVES the deletion', oneWay.indexOf('still DATA') !== -1)

// retry-ok
// ── CC 24-char title truncation awareness ─────────────────────────────────
// The bridge returns titles truncated to 24 chars + '…', so a full spawn name
// never exact-matches its live label. These guard the resolution primitive.
ok('trunc: detects the ellipsis label', coord._isTruncatedLabel('[slice worker checkin 20…') === true)
ok('trunc: exact match for short labels', coord._labelMatchesStored('Studio', 'Studio') === true)
ok('trunc: live-truncated matches stored full name',
  coord._labelMatchesStored('[slice worker checkin 20…', '[slice worker checkin 2026 08 03]') === true)
ok('trunc: rejects an unrelated stored name',
  coord._labelMatchesStored('[studio nuance data coll…', '[slice worker checkin 2026 08 03]') === false)
ok('trunc: rejects a too-short visible prefix (stub, <6 chars)',
  coord._labelMatchesStored('[a…', '[abc def ghij]') === false)
ok('trunc: a non-truncated differing label is NOT a loose-prefix match',
  coord._labelMatchesStored('[slice worker]', '[slice worker checkin 2026]') === false)

// _matchWorkerRow: truncation-aware sentinel match, uniqueness-gated (collision
// refuses rather than guesses). liveWorkers passed directly so no registry setup.
const wRow = (tab_id, sentinel, vc) => ({ tab_id, terminated_at: null, tab_handle: { sentinel_prefix: sentinel, viewColumn: vc } })
{
  const truncTab = { label: '[slice worker checkin 20…', viewColumn: 1, index: 4 }
  const one = coord._matchWorkerRow(truncTab, [wRow('tab_A', '[slice worker checkin 2026 08 03]', 1)])
  ok('matchWorkerRow: truncated live tab resolves to its worker via sentinel', one && one.tab_id === 'tab_A')

  const collide = coord._matchWorkerRow(truncTab, [
    wRow('tab_A', '[slice worker checkin 2026 08 03a]', 1),
    wRow('tab_B', '[slice worker checkin 2026 08 03b]', 1),
  ])
  ok('matchWorkerRow: truncation collision REFUSES (no wrong-match)', collide === null)

  const none = coord._matchWorkerRow({ label: 'Chambers', viewColumn: 1, index: 9 }, [wRow('tab_A', '[slice worker checkin 2026 08 03]', 1)])
  ok('matchWorkerRow: unrelated tab does not match a worker', none === null)
}

// ── resolveLiveTargetTab branches with a stubbed live tab list ────────────
// Stub the injection module's listChatTabs so resolution is deterministic.
const chatInject = require('./chat-inject')
const realList = chatInject.listChatTabs
async function withTabs(tabs, fn) {
  chatInject.listChatTabs = async () => tabs
  try { return await fn() } finally { chatInject.listChatTabs = realList }
}

;(async () => {
  // label resolves to the unique slug match
  await withTabs(
    [
      { label: 'Studio', viewColumn: 1, index: 0, isActive: false, viewType: 'mainThreadWebview-claudeVSCodePanel' },
      { label: 'Chambers CH', viewColumn: 1, index: 1, isActive: true, viewType: 'mainThreadWebview-claudeVSCodePanel' },
    ],
    async () => {
      // A chat.label: topic left on disk from before the deletion must NOT inject.
      // Positive control below (conductor still resolves) is what makes this
      // meaningful: otherwise "refuses" is indistinguishable from "resolver dead".
      const r = await coord._resolveLiveTargetTab('chat.label:studio.inbox')
      ok('a legacy label topic no longer resolves to a live tab', r.ok === false)
      const bare = await coord._resolveLiveTargetTab('chat.Studio.inbox')
      ok('an exact live title is NOT an address (bare-label fallback deleted)',
        bare.ok === false && bare.reason === 'target_unresolved')

      // conductor addressing v2: with a registered conductor whose title_match is
      // a live non-worker tab label, `conductor` resolves to that unique tab
      // (the deleted v1 "single active human tab" fallback is gone).
      seedConductor({ tab_id: 'conductor', title_match: 'Chambers CH', title_fingerprint: null, in_turn: false })
      const c = await coord._resolveLiveTargetTab('chat.conductor.inbox')
      clearConductor()
      ok('conductor resolves to the registered non-worker tab by title_match', c.ok === true && c.label === 'Chambers CH')
    },
  )

  // v2 fail-safe: `conductor` must NEVER resolve to a dispatched worker
  // ([EOS-W-...]); worker tabs are excluded from the resolution pool. With the
  // registered title_match matching no live NON-worker tab, resolution fails safe
  // (conductor_unresolved) so the message stays inbox-queued and the human sees it
  // via the conductor-inbox peek, instead of a worker silently consuming it. This
  // is the root-cause guard against conductor staleness misrouting into a running
  // worker while Tate is away.
  await withTabs(
    [
      { label: '[EOS-W-3d7212fc] <dispatched build>', viewColumn: 1, index: 0, isActive: true, viewType: 'mainThreadWebview-claudeVSCodePanel' },
    ],
    async () => {
      seedConductor({ tab_id: 'conductor', title_match: 'Conductor Chat', title_fingerprint: null, in_turn: false })
      const r = await coord._resolveLiveTargetTab('chat.conductor.inbox')
      clearConductor()
      ok('conductor never resolves to a worker tab (fails safe, unresolved)', r.ok === false && r.reason === 'conductor_unresolved')
    },
  )

  // A live non-worker tab whose label matches the registered title_match resolves
  // to it even when a worker tab is also live (worker excluded from the pool).
  await withTabs(
    [
      { label: '[EOS-W-3d7212fc] <dispatched build>', viewColumn: 1, index: 0, isActive: false, viewType: 'mainThreadWebview-claudeVSCodePanel' },
      { label: 'Co-Exist Invoice', viewColumn: 1, index: 1, isActive: true, viewType: 'mainThreadWebview-claudeVSCodePanel' },
    ],
    async () => {
      seedConductor({ tab_id: 'conductor', title_match: 'Co-Exist Invoice', title_fingerprint: null, in_turn: false })
      const r = await coord._resolveLiveTargetTab('chat.conductor.inbox')
      clearConductor()
      ok('conductor resolves to the registered non-worker tab beside a worker', r.ok === true && r.label === 'Co-Exist Invoice')
    },
  )

  // v2 ambiguity guard: when the registered title_match matches MORE than one live
  // non-worker tab, refuse rather than guess (conductor_ambiguous_label).
  await withTabs(
    [
      { label: 'Ops', viewColumn: 1, index: 0, isActive: true, viewType: 'mainThreadWebview-claudeVSCodePanel' },
      { label: 'Ops', viewColumn: 2, index: 0, isActive: false, viewType: 'mainThreadWebview-claudeVSCodePanel' },
    ],
    async () => {
      seedConductor({ tab_id: 'conductor', title_match: 'Ops', title_fingerprint: null, in_turn: false })
      const r = await coord._resolveLiveTargetTab('chat.conductor.inbox')
      clearConductor()
      ok('conductor refuses an ambiguous title_match (2 live tabs)', r.ok === false && r.reason === 'conductor_ambiguous_label')
    },
  )

  // duplicate label slug -> ambiguous refuse
  await withTabs(
    [
      { label: 'Claude Code', viewColumn: 1, index: 0, isActive: false, viewType: 'mainThreadWebview-claudeVSCodePanel' },
      { label: 'Claude Code', viewColumn: 2, index: 0, isActive: false, viewType: 'mainThreadWebview-claudeVSCodePanel' },
    ],
    async () => {
      const r = await coord._resolveLiveTargetTab('chat.label:claude-code.inbox')
      ok('a colliding label topic refuses (scheme deleted, so it never resolves)', r.ok === false)
    },
  )

  // normalizeToAddress is DELETED. Its tail was `return addressForLabel(to)`, an
  // unconditional last resort that turned any unrecognised string into a
  // real-looking address on an inbox nobody polls. The replacement refuses, and
  // it refuses WITH live tabs present, which is the case the old one "solved".
  await withTabs(
    [{ label: 'Budgetting', viewColumn: 1, index: 0, isActive: false, viewType: 'mainThreadWebview-claudeVSCodePanel' }],
    async () => {
      ok('a label substring is REFUSED even with that tab live', coord._canonicalAddress('budget') === null)
      ok('an exact live label is REFUSED even with that tab live', coord._canonicalAddress('Budgetting') === null)
    },
  )

  // pushInject respects the kill-switch
  const prev = process.env.COORD_CHAT_INJECT
  process.env.COORD_CHAT_INJECT = '0'
  const disabled = await coord._pushInject({ to: 'chat.session:studio9.inbox', body: { type: 'chat', text: 'hi' } })
  ok('pushInject disabled by COORD_CHAT_INJECT=0', disabled.attempted === false && disabled.reason === 'disabled')
  if (prev === undefined) delete process.env.COORD_CHAT_INJECT; else process.env.COORD_CHAT_INJECT = prev

  // pushInject skips non-chat messages
  const nonchat = await coord._pushInject({ to: 'chat.conductor.inbox', body: { type: 'done' } })
  ok('pushInject skips non-chat', nonchat.attempted === false && nonchat.reason === 'not_chat')

  console.log('\n' + passed + ' checks passed')
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  if (process.exitCode) { console.error('\nSOME CHECKS FAILED'); process.exit(1) }
})()
