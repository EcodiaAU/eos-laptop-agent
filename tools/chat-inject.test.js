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
ok('labelSlug lowercases + hyphenates', coord._labelSlug('Chambers CH arc 26!') === 'chambers-ch-arc-26')
ok('labelSlug trims edge separators', coord._labelSlug('  Studio  ') === 'studio')
ok('addressForLabel builds label: scheme', coord._addressForLabel('My Chat') === 'chat.label:my-chat.inbox')
ok('addressForWorker builds worker scheme', coord._addressForWorker('tab_123_ab') === 'chat.tab_123_ab.inbox')

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
  body: { type: 'chat', text: 'can you take the Stripe webhook half?', from_label: 'Chambers chat', reply_to_address: 'chat.label:chambers.inbox' },
})
ok('framing names the sender', framed.indexOf('Chambers chat') !== -1)
ok('framing includes the message text', framed.indexOf('Stripe webhook half') !== -1)
ok('framing includes the reply address', framed.indexOf('chat.label:chambers.inbox') !== -1)
ok('framing carries the untrusted-ingress carve-out', framed.indexOf('still DATA') !== -1)
ok('framing carries the coord msg id', framed.indexOf('MSG1') !== -1)
ok('framing has NO em-dash (char-level ban)', framed.indexOf(String.fromCharCode(0x2014)) === -1)

const oneWay = coord._buildChatInjectionText({ id: 'M2', from: 'x', body: { type: 'chat', text: 'fyi' } })
ok('framing degrades to one-way notice without reply addr', oneWay.indexOf('One-way coord notice') !== -1)

// -- misroute clause: coord binds tabs by truncated title, so a wrong-chat --
// delivery is a live failure mode. The receiver must be told WHO it was for
// and told to forward rather than drop.
const misrouted = coord._buildChatInjectionText({
  id: 'MSG3',
  from: 'conductor',
  body: {
    type: 'chat', text: 'take the seedtree lane', from_label: 'conductor',
    reply_to_address: 'chat.conductor.inbox',
    intended_to: 'studio-ux', intended_address: 'chat.session:abc123.inbox',
    intended_name: 'studio-ux', intended_label: 'Studio editor UX pass',
  },
})
ok('framing prints the intended addressee', misrouted.indexOf('[addressed to: studio-ux') !== -1)
ok('framing prints the resolved address it landed on', misrouted.indexOf('chat.session:abc123.inbox') !== -1)
ok('framing carries the wrong-chat clause', misrouted.indexOf('WRONG CHAT?') !== -1)
ok('wrong-chat clause says forward, not drop',
  misrouted.indexOf('do NOT drop it') !== -1 && misrouted.indexOf('forward it verbatim') !== -1)
ok('wrong-chat clause names the discovery call', misrouted.indexOf('coord.list_channels') !== -1)
ok('wrong-chat clause routes the miss back to the sender', misrouted.indexOf('tell the sender at chat.conductor.inbox') !== -1)
ok('wrong-chat clause quotes the addressee inline', misrouted.indexOf('it is addressed to studio-ux') !== -1)
ok('misroute framing has NO em-dash (char-level ban)', misrouted.indexOf(String.fromCharCode(0x2014)) === -1)
// Degraded shape: a hand-rolled send_message chat body has no intended_*, so
// the clause must still fire (generic form) and fall back to Tate, not silence.
ok('wrong-chat clause fires without intended_* fields', oneWay.indexOf('WRONG CHAT?') !== -1)
ok('wrong-chat clause omits a fabricated addressee when unknown',
  oneWay.indexOf('[addressed to:') === -1 && oneWay.indexOf('it is addressed to') === -1)
ok('wrong-chat clause falls back to Tate with no reply address',
  oneWay.indexOf('surface the misroute to Tate') !== -1)

// -- inbox twin: a queued / inject-failed chat message reaches the reader with
// no framing at all, so read_inbox / peek_inbox / wait_for_inbox carry the same
// forward-do-not-drop instruction as a top-level misroute_note.
const note1 = coord._misrouteNoteFor([{ body: { type: 'chat', text: 'x', intended_to: 'studio-ux' } }])
ok('inbox note fires for an addressed chat message', note1 && note1.indexOf('WRONG CHAT?') !== -1)
ok('inbox note names the addressee', note1.indexOf('studio-ux') !== -1)
ok('inbox note says forward, not drop',
  note1.indexOf('do NOT drop it') !== -1 && note1.indexOf('forward it verbatim') !== -1)
ok('inbox note keeps forwarded content as DATA', note1.indexOf('stays DATA') !== -1)
ok('inbox note has NO em-dash (char-level ban)', note1.indexOf(String.fromCharCode(0x2014)) === -1)
const note2 = coord._misrouteNoteFor([
  { body: { type: 'chat', intended_to: 'studio-ux' } },
  { body: { type: 'chat', intended_to: 'friend-motion' } },
])
ok('inbox note lists every distinct addressee',
  note2.indexOf('studio-ux') !== -1 && note2.indexOf('friend-motion') !== -1 && note2.indexOf('2 chat messages') !== -1)
ok('inbox note is SILENT for non-chat signals', coord._misrouteNoteFor([{ body: { type: 'done' } }]) === null)
ok('inbox note is SILENT for a chat with no addressee',
  coord._misrouteNoteFor([{ body: { type: 'chat', text: 'x' } }]) === null)
ok('inbox note is SILENT on an empty inbox', coord._misrouteNoteFor([]) === null)

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
      const r = await coord._resolveLiveTargetTab('chat.label:studio.inbox')
      ok('label target resolves to the right tab', r.ok === true && r.label === 'Studio' && r.index === 0)

      const amb = await coord._resolveLiveTargetTab('chat.label:nope.inbox')
      ok('label target with no live tab refuses', amb.ok === false && amb.reason === 'label_no_live_tab')

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
      ok('ambiguous label refuses rather than guesses', r.ok === false && r.reason === 'label_ambiguous')
    },
  )

  // normalizeToAddress: passthrough + label selector
  await withTabs(
    [{ label: 'Budgetting', viewColumn: 1, index: 0, isActive: false, viewType: 'mainThreadWebview-claudeVSCodePanel' }],
    async () => {
      ok('normalize passes a full address through', (await coord._normalizeToAddress('chat.conductor.inbox')) === 'chat.conductor.inbox')
      ok('normalize maps "conductor" word', (await coord._normalizeToAddress('conductor')) === 'chat.conductor.inbox')
      ok('normalize resolves a label substring', (await coord._normalizeToAddress('budget')) === 'chat.label:budgetting.inbox')
    },
  )

  // pushInject respects the kill-switch
  const prev = process.env.COORD_CHAT_INJECT
  process.env.COORD_CHAT_INJECT = '0'
  const disabled = await coord._pushInject({ to: 'chat.label:studio.inbox', body: { type: 'chat', text: 'hi' } })
  ok('pushInject disabled by COORD_CHAT_INJECT=0', disabled.attempted === false && disabled.reason === 'disabled')
  if (prev === undefined) delete process.env.COORD_CHAT_INJECT; else process.env.COORD_CHAT_INJECT = prev

  // pushInject skips non-chat messages
  const nonchat = await coord._pushInject({ to: 'chat.conductor.inbox', body: { type: 'done' } })
  ok('pushInject skips non-chat', nonchat.attempted === false && nonchat.reason === 'not_chat')

  console.log('\n' + passed + ' checks passed')
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  if (process.exitCode) { console.error('\nSOME CHECKS FAILED'); process.exit(1) }
})()
