'use strict'

// Unit tests for the scored, freshness-filtered chat resolver (coord.js v4,
// 2026-08-21). Mirrors the EXACT collision cases observed live on 2026-08-21:
//   - two chats titled "Studio rejected on plays…"           (ambiguous auto-title)
//   - "Can you make the friend …" vs "Can you create a friend …"  (near-twin prefixes)
//   - 1000+ dead anchors, one of whose stale (label,pos) collides with a live tab
// Proves: names resolve decisively, siblings split by token-coverage, a bare
// shared token stays ambiguous (candidates, NOT a silent pick), dead anchors are
// excluded, and coord.name_chat persists a stable handle.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-resolve.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')
const assert = require('assert')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-resolve-test-'))
process.env.COORD_ROOT = tmpRoot
const CHAT_TABS = path.join(tmpRoot, 'chat-tabs')
fs.mkdirSync(CHAT_TABS, { recursive: true })

const coord = require('./coord')
const chatInject = require('./chat-inject')
const realList = chatInject.listChatTabs

const NOW = Math.floor(Date.now() / 1000)
function anchor(sid, o) {
  fs.writeFileSync(path.join(CHAT_TABS, sid + '.json'),
    JSON.stringify(Object.assign({ session_id: sid, role: 'conductor', updated_at: NOW }, o)))
}
async function withTabs(tabs, fn) {
  chatInject.listChatTabs = async () => tabs
  try { return await fn() } finally { chatInject.listChatTabs = realList }
}

let passed = 0
function ok(name, cond) {
  if (!cond) { console.error('FAIL: ' + name); process.exitCode = 1 }
  else { passed++; console.log('ok - ' + name) }
}

;(async () => {
  // ── canonical fast-paths (unchanged, stable) ──────────────────────────────
  ok('canonical: full address passes through', coord._canonicalAddress('chat.conductor.inbox') === 'chat.conductor.inbox')
  ok('canonical: conductor keyword', coord._canonicalAddress('conductor') === 'chat.conductor.inbox')
  ok('canonical: session id', coord._canonicalAddress('session:abc') === 'chat.session:abc.inbox')
  ok('canonical: a bare selector is NOT canonical', coord._canonicalAddress('studio ux') === null)

  // ── scorer tiers ─────────────────────────────────────────────────────────
  ok('score: exact name beats everything', coord._scoreCandidate('studio-ux', { name: 'studio-ux', label: 'zzz' }) >= 1000)
  ok('score: slug-equal name matches loose input', coord._scoreCandidate('Studio UX', { name: 'studio-ux' }) >= 1000)
  ok('score: full token coverage of label scores > partial',
    coord._scoreCandidate('create a friend', { label: 'Can you create a friend …' }) >
    coord._scoreCandidate('create a friend', { label: 'Can you make the friend …' }))
  ok('score: no signal is zero', coord._scoreCandidate('daycrew', { label: 'Studio rejected on plays…' }) === 0)

  // ── CASE 1: two live chats share the truncated auto-title (the live bug) ───
  anchor('s-android', { label: 'Studio rejected on plays…', viewColumn: 1, index: 2 })
  anchor('s-review', { label: 'Studio rejected on plays…', viewColumn: 1, index: 5 })
  const twinTabs = [
    { label: 'Studio rejected on plays…', viewColumn: 1, index: 2, isActive: false },
    { label: 'Studio rejected on plays…', viewColumn: 1, index: 5, isActive: false },
  ]
  await withTabs(twinTabs, async () => {
    const r = await coord.resolveSelector('studio rejected on plays')
    ok('twins: shared auto-title is AMBIGUOUS, not a silent pick', r.ok === false && r.reason === 'ambiguous')
    ok('twins: both returned as ranked candidates', (r.candidates || []).length === 2)
    ok('twins: candidates carry stable session addresses',
      r.candidates.every(c => /^chat\.session:s-(android|review)\.inbox$/.test(c.address)))
  })

  // ── CASE 2: name one twin -> it resolves DECISIVELY by name ───────────────
  await withTabs(twinTabs, async () => {
    const named = await coord.name_chat({ name: 'studio-android', context: 'Android paywall reject vc7', session_id: 's-android' })
    ok('name_chat: writes + returns stable address', named.ok && named.address === 'chat.session:s-android.inbox')
    const r = await coord.resolveSelector('studio-android')
    ok('named twin resolves decisively', r.ok === true && r.address === 'chat.session:s-android.inbox')
    ok('named resolve is session-kind', r.kind === 'session')
  })
  // persistence shape: the name is on disk for the next heartbeat to preserve
  ok('name persisted to anchor on disk',
    JSON.parse(fs.readFileSync(path.join(CHAT_TABS, 's-android.json'), 'utf8')).name === 'studio-android')

  // ── CASE 3: near-twin siblings split by token coverage; bare token stays amb ─
  anchor('s-make', { label: 'Can you make the friend …', viewColumn: 1, index: 3 })
  anchor('s-create', { label: 'Can you create a friend …', viewColumn: 1, index: 4 })
  const friendTabs = [
    { label: 'Can you make the friend …', viewColumn: 1, index: 3, isActive: false },
    { label: 'Can you create a friend …', viewColumn: 1, index: 4, isActive: false },
  ]
  await withTabs(friendTabs, async () => {
    const r1 = await coord.resolveSelector('create a friend')
    ok('siblings: "create a friend" resolves to the CREATE chat', r1.ok === true && r1.address === 'chat.session:s-create.inbox')
    const r2 = await coord.resolveSelector('friend')
    ok('siblings: bare "friend" is ambiguous (candidates, not a guess)', r2.ok === false && (r2.candidates || []).length === 2)
  })

  // ── CASE 4: a DEAD anchor whose (label,pos) collides is excluded ──────────
  anchor('s-ghost', { name: 'ghost-chat', label: 'Ghost work…', viewColumn: 1, index: 9, updated_at: NOW - 3 * 3600 })
  await withTabs([{ label: 'Ghost work…', viewColumn: 1, index: 9, isActive: false }], async () => {
    const fresh = coord._freshAnchors()
    ok('freshness: dead anchor is not in the fresh set', !fresh.some(a => a.session_id === 's-ghost'))
    const r = await coord.resolveSelector('ghost-chat')
    // The live tab shares the token "ghost" so it MAY resolve - but it must resolve
    // to the LIVE tab as an anonymous label, NEVER via the dead anchor's stable
    // session address (that is the spurious-revival failure we are excluding).
    ok('freshness: never resolves via the DEAD anchor session address', r.address !== 'chat.session:s-ghost.inbox')
  })

  // ── CASE 5: an anonymous live tab (no anchor) is still reachable by label ──
  await withTabs([{ label: 'Chambers arc 26', viewColumn: 1, index: 0, isActive: true }], async () => {
    const r = await coord.resolveSelector('chambers')
    ok('anonymous live tab resolves by label token', r.ok === true && r.kind === 'label')
  })

  console.log('\n' + passed + ' assertions passed')
  chatInject.listChatTabs = realList
})().catch((e) => { console.error(e); process.exitCode = 1 })
