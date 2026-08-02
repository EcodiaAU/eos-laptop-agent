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

      // conductor falls back to the single active tab when title_match is a worker sentinel
      const c = await coord._resolveLiveTargetTab('chat.conductor.inbox')
      ok('conductor resolves to the single active tab', c.ok === true && c.label === 'Chambers CH')
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
