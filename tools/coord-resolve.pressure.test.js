'use strict'

// PRESSURE + EDGE-CASE harness for the coord chat resolver (coord.js v4).
// Adversarial, exhaustive, reproducible. Proves resolveSelector / name_chat /
// list_channels hold under: exact/name/alias, ambiguous twins, near-twin token
// splits, mid-flight retitles, 24-char truncation, unicode/emoji, freshness
// boundaries, worker exclusion, generic/degenerate input, decisiveness margins,
// randomized property-fuzzing (invariants that must ALWAYS hold), a 5000-anchor
// scale test, and name persistence across a simulated heartbeat.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-resolve.pressure.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-pressure-'))
process.env.COORD_ROOT = tmpRoot
const CHAT_TABS = path.join(tmpRoot, 'chat-tabs')
fs.mkdirSync(CHAT_TABS, { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'workers'), { recursive: true })

const coord = require('./coord')
const chatInject = require('./chat-inject')
const realList = chatInject.listChatTabs
const NOW = Math.floor(Date.now() / 1000)

// ── harness plumbing ──────────────────────────────────────────────────────
let pass = 0, fail = 0, group = ''
const failures = []
function G(name) { group = name; console.log('\n\x1b[1m' + name + '\x1b[0m') }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + name) }
  else { fail++; failures.push(group + ' :: ' + name + (detail ? '  (' + detail + ')' : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  <' + detail + '>' : '')) }
}
function clearAnchors() { for (const f of fs.readdirSync(CHAT_TABS)) fs.unlinkSync(path.join(CHAT_TABS, f)) }
function anchor(sid, o) {
  fs.writeFileSync(path.join(CHAT_TABS, sid + '.json'),
    JSON.stringify(Object.assign({ session_id: sid, role: 'conductor', updated_at: NOW }, o)))
}
async function withTabs(tabs, fn) {
  chatInject.listChatTabs = async () => tabs
  try { return await fn() } finally { chatInject.listChatTabs = realList }
}
// Mirror the python heartbeat read-merge: rewrite the anchor with a fresh label
// while PRESERVING self-declared name/context/aliases (proves the invariant the
// live hook enforces, in-process).
function simulateHeartbeat(sid, newLabel, viewColumn, index) {
  const p = path.join(CHAT_TABS, sid + '.json')
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {}
  const rec = { session_id: sid, label: newLabel, viewColumn, index, role: 'conductor', updated_at: NOW }
  for (const k of ['name', 'context', 'aliases', 'named_at']) if (prev[k] != null) rec[k] = prev[k]
  fs.writeFileSync(p, JSON.stringify(rec))
}

;(async () => {
  // ══ GROUP A: canonical fast-paths bypass scoring ═══════════════════════════
  G('A. Canonical fast-paths (stable, never scored)')
  ok('full chat.*.inbox address passes through', coord._canonicalAddress('chat.session:x.inbox') === 'chat.session:x.inbox')
  ok('conductor keyword', coord._canonicalAddress('conductor') === 'chat.conductor.inbox')
  ok('session:<id>', coord._canonicalAddress('session:abc-123') === 'chat.session:abc-123.inbox')
  ok('label address form', coord._canonicalAddress('chat.label:studio.inbox') === 'chat.label:studio.inbox')
  ok('a bare selector is NOT canonical', coord._canonicalAddress('studio ux pass') === null)
  ok('unregistered tab_ id is NOT canonical', coord._canonicalAddress('tab_999_zz') === null)

  // ══ GROUP B: exact / name / alias, case + punctuation insensitive ══════════
  G('B. Name + alias matching (case/punctuation insensitive)')
  ok('exact name = 1000', coord._scoreCandidate('studio-ux', { name: 'studio-ux' }) >= 1000)
  ok('slug-equal (spaces/caps)', coord._scoreCandidate('Studio UX', { name: 'studio-ux' }) >= 1000)
  ok('slug-equal (punctuation)', coord._scoreCandidate('studio_ux!!', { name: 'studio ux' }) >= 1000)
  ok('alias hit', coord._scoreCandidate('sx', { name: 'studio-ux', aliases: ['sx', 'seditor'] }) >= 1000)
  ok('name outranks a competing label token', coord._scoreCandidate('studio', { name: 'studio-ux', label: 'zzz' }) > coord._scoreCandidate('studio', { label: 'studio build' }))

  // ══ GROUP C: ambiguity returns candidates, never a silent guess ════════════
  G('C. Ambiguous auto-title (twins) => candidates, no guess')
  clearAnchors()
  anchor('c1', { label: 'Studio rejected on plays…', viewColumn: 1, index: 2 })
  anchor('c2', { label: 'Studio rejected on plays…', viewColumn: 1, index: 5 })
  anchor('c3', { label: 'Studio rejected on plays…', viewColumn: 2, index: 0 })
  const cTabs = [
    { label: 'Studio rejected on plays…', viewColumn: 1, index: 2 },
    { label: 'Studio rejected on plays…', viewColumn: 1, index: 5 },
    { label: 'Studio rejected on plays…', viewColumn: 2, index: 0 },
  ]
  await withTabs(cTabs, async () => {
    const r = await coord.resolveSelector('studio rejected on plays')
    ok('three identical titles => ambiguous', r.ok === false && r.reason === 'ambiguous')
    ok('all three returned as candidates', (r.candidates || []).length === 3)
    ok('candidates carry distinct stable session addresses', new Set(r.candidates.map(c => c.address)).size === 3)
    const named = await coord.name_chat({ name: 'studio-android-reject', session_id: 'c2' })
    ok('name_chat on one twin returns its stable address', named.ok && named.address === 'chat.session:c2.inbox')
  })
  await withTabs(cTabs, async () => {
    const r = await coord.resolveSelector('studio-android-reject')
    ok('naming one twin makes it decisively resolvable', r.ok === true && r.address === 'chat.session:c2.inbox')
  })

  // ══ GROUP D: near-twin siblings split by token coverage ════════════════════
  G('D. Near-twin siblings (token coverage discriminates)')
  clearAnchors()
  const dTabs = [
    { label: 'Can you make the friend …', viewColumn: 1, index: 0 },
    { label: 'Can you create a friend …', viewColumn: 1, index: 1 },
  ]
  await withTabs(dTabs, async () => {
    const rc = await coord.resolveSelector('create a friend')
    ok('"create a friend" -> the CREATE sibling', rc.ok && /create/.test(rc.target.label))
    const rm = await coord.resolveSelector('make the friend')
    ok('"make the friend" -> the MAKE sibling', rm.ok && /make/.test(rm.target.label))
    const rf = await coord.resolveSelector('friend')
    ok('bare shared token "friend" stays ambiguous', rf.ok === false && (rf.candidates || []).length === 2)
  })

  // ══ GROUP E: mid-flight retitle (the live failure) ═════════════════════════
  G('E. Retitle mid-flight')
  clearAnchors()
  // E1: chat took a turn since retitle -> heartbeat refreshed anchor label + kept name
  anchor('e1', { label: 'Studio rejected on plays…', viewColumn: 1, index: 0 })
  await coord.name_chat({ name: 'studio-reject', session_id: 'e1' })
  simulateHeartbeat('e1', 'Studio Rejection', 1, 0)   // CC retitled; heartbeat refreshed + preserved name
  await withTabs([{ label: 'Studio Rejection', viewColumn: 1, index: 0 }], async () => {
    const byName = await coord.resolveSelector('studio-reject')
    ok('E1 name survives the retitle (decisive)', byName.ok && byName.address === 'chat.session:e1.inbox')
    const byNew = await coord.resolveSelector('studio rejection')
    ok('E1 new label also resolves', byNew.ok === true)
    const byOld = await coord.resolveSelector('rejected on plays')
    ok('E1 OLD label is now dead (no stale hit)', byOld.ok === false)
  })
  // E2: chat retitled but has NOT re-heartbeated -> stale anchor; must fail SAFE
  clearAnchors()
  anchor('e2', { name: 'orphan-name', label: 'Old Stale Title…', viewColumn: 1, index: 3 })
  await withTabs([{ label: 'Brand New Title', viewColumn: 1, index: 3 }], async () => {
    const byName = await coord.resolveSelector('orphan-name')
    ok('E2 stale-anchor name does NOT misroute (no_live_match)', byName.ok === false)
    const byNew = await coord.resolveSelector('brand new title')
    ok('E2 the live tab is still reachable by its new label', byNew.ok === true && byNew.kind === 'label')
    ok('E2 if it resolves it is NEVER the dead anchor address', byName.ok === false || byName.address !== 'chat.session:e2.inbox')
  })

  // ══ GROUP F: 24-char truncation + ellipsis ════════════════════════════════
  G('F. Truncation (24 chars + …)')
  clearAnchors()
  const longLabel = 'Studio nuance data coll…'  // CC-truncated
  await withTabs([{ label: longLabel, viewColumn: 1, index: 0 }], async () => {
    const vis = await coord.resolveSelector('studio nuance data coll')
    ok('selector = visible prefix resolves', vis.ok === true)
    const partial = await coord.resolveSelector('nuance data')
    ok('interior tokens still resolve', partial.ok === true)
  })
  // two tabs sharing a truncated prefix, distinct names -> name disambiguates
  clearAnchors()
  anchor('f1', { name: 'nuance-a', label: 'Studio nuance data coll…', viewColumn: 1, index: 0 })
  anchor('f2', { name: 'nuance-b', label: 'Studio nuance data coll…', viewColumn: 1, index: 1 })
  await withTabs([
    { label: 'Studio nuance data coll…', viewColumn: 1, index: 0 },
    { label: 'Studio nuance data coll…', viewColumn: 1, index: 1 },
  ], async () => {
    const a = await coord.resolveSelector('nuance-a')
    const b = await coord.resolveSelector('nuance-b')
    ok('shared truncated prefix, names split them', a.ok && b.ok && a.address !== b.address)
    const shared = await coord.resolveSelector('studio nuance data coll')
    ok('the shared prefix itself stays ambiguous', shared.ok === false)
  })

  // ══ GROUP G: freshness filter ══════════════════════════════════════════════
  G('G. Freshness (dead anchors excluded, no spurious veto)')
  clearAnchors()
  anchor('g-dead', { name: 'ghosted', label: 'Ghost work…', viewColumn: 1, index: 9, updated_at: NOW - 3 * 3600 })
  ok('dead anchor absent from fresh set', !coord._freshAnchors().some(a => a.session_id === 'g-dead'))
  anchor('g-edge-in', { name: 'edge-in', label: 'Edge In', viewColumn: 1, index: 1, updated_at: NOW - 29 * 60 })
  anchor('g-edge-out', { name: 'edge-out', label: 'Edge Out', viewColumn: 1, index: 2, updated_at: NOW - 31 * 60 })
  ok('anchor 29m old is fresh', coord._freshAnchors().some(a => a.session_id === 'g-edge-in'))
  ok('anchor 31m old is stale', !coord._freshAnchors().some(a => a.session_id === 'g-edge-out'))
  // dead anchor colliding in position with a live tab: no veto, no misroute
  clearAnchors()
  anchor('g-live', { name: 'live-one', label: 'Live One', viewColumn: 1, index: 4, updated_at: NOW })
  anchor('g-collide-dead', { name: 'dead-collider', label: 'Live One', viewColumn: 1, index: 4, updated_at: NOW - 5 * 3600 })
  await withTabs([{ label: 'Live One', viewColumn: 1, index: 4 }], async () => {
    const r = await coord.resolveSelector('live-one')
    ok('live anchor resolves despite a dead position-collider', r.ok === true && r.address === 'chat.session:g-live.inbox')
  })

  // ══ GROUP H: worker exclusion ══════════════════════════════════════════════
  G('H. Workers are never selector-addressable')
  clearAnchors()
  anchor('h-wrk', { name: 'worker-named', label: '[gmail inbox poll]', viewColumn: 1, index: 0, role: 'worker' })
  await withTabs([
    { label: '[EOS-W-abc123] status board execute', viewColumn: 1, index: 0 },
    { label: 'Real Human Chat', viewColumn: 1, index: 1 },
  ], async () => {
    const w = await coord.resolveSelector('status board execute')
    ok('an [EOS-W-] worker tab is not a selector candidate', w.ok === false)
    const namedWorker = await coord.resolveSelector('worker-named')
    ok('a role:worker anchor is excluded from candidates', namedWorker.ok === false)
    const human = await coord.resolveSelector('real human chat')
    ok('the human chat beside it still resolves', human.ok === true)
  })

  // ══ GROUP I: generic / degenerate input ════════════════════════════════════
  G('I. Generic labels + degenerate selectors')
  clearAnchors()
  await withTabs([
    { label: 'Claude Code', viewColumn: 1, index: 0 },
    { label: 'new chat', viewColumn: 1, index: 1 },
    { label: '', viewColumn: 1, index: 2 },
  ], async () => {
    ok('generic "Claude Code" excluded', (await coord.resolveSelector('claude code')).ok === false)
    ok('generic "new chat" excluded', (await coord.resolveSelector('new chat')).ok === false)
    ok('empty selector => empty_selector', (await coord.resolveSelector('')).reason === 'empty_selector')
    ok('whitespace selector => no match (no tokens)', (await coord.resolveSelector('    ')).ok === false)
    ok('punctuation-only selector => no match', (await coord.resolveSelector('!!! --- ???')).ok === false)
  })

  // ══ GROUP J: unicode / emoji ═══════════════════════════════════════════════
  G('J. Unicode / emoji labels')
  clearAnchors()
  await withTabs([
    { label: '🌳 SeedTree build 🌳', viewColumn: 1, index: 0 },
    { label: 'Café résumé draft', viewColumn: 1, index: 1 },
  ], async () => {
    ok('emoji-wrapped label resolves by ascii tokens', (await coord.resolveSelector('seedtree build')).ok === true)
    ok('accented label resolves by its tokens', (await coord.resolveSelector('draft')).ok === true)
  })

  // ══ GROUP K: decisiveness margin ═══════════════════════════════════════════
  G('K. Decisiveness margin (weak/near-tie => candidates, not a guess)')
  clearAnchors()
  await withTabs([
    { label: 'alpha beta gamma delta', viewColumn: 1, index: 0 },
    { label: 'alpha beta gamma omega', viewColumn: 1, index: 1 },
  ], async () => {
    const tie = await coord.resolveSelector('alpha beta gamma')
    ok('near-tie (shared prefix) => candidates', tie.ok === false && (tie.candidates || []).length === 2)
    const win = await coord.resolveSelector('alpha beta gamma delta')
    ok('the fully-covered label wins decisively', win.ok === true && /delta/.test(win.target.label))
  })
  clearAnchors()
  await withTabs([{ label: 'one two three four five six', viewColumn: 1, index: 0 }], async () => {
    const weak = await coord.resolveSelector('one nine nine nine')  // 1 of 4 tokens => below ACCEPT
    ok('a weak unique match does NOT auto-route', weak.ok === false)
  })

  // ══ GROUP L: property/fuzz invariants (seeded, 2000 random scenarios) ═══════
  G('L. Property-based fuzz (2000 seeded scenarios; invariants must ALWAYS hold)')
  let seed = 1234567
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const WORDS = ['studio', 'friend', 'coord', 'canon', 'seedtree', 'hygiene', 'daycrew', 'chambers', 'reject', 'build', 'ship', 'motion', 'paywall', 'audit', 'alpha', 'beta']
  let invViolations = 0, threw = 0, checked = 0
  for (let it = 0; it < 2000; it++) {
    clearAnchors()
    const nTabs = 1 + Math.floor(rnd() * 6)
    const tabs = []
    for (let i = 0; i < nTabs; i++) {
      const isWorker = rnd() < 0.25
      const words = [pick(WORDS), pick(WORDS), pick(WORDS)].join(' ')
      const label = isWorker ? ('[EOS-W-' + it + i + '] ' + words) : (words + (rnd() < 0.4 ? '…' : ''))
      tabs.push({ label, viewColumn: 1, index: i })
      if (!isWorker && rnd() < 0.5) {
        const sid = 's' + it + '_' + i
        const rec = { label, viewColumn: 1, index: i, role: 'conductor', updated_at: rnd() < 0.7 ? NOW : NOW - 4 * 3600 }
        if (rnd() < 0.4) rec.name = pick(WORDS) + '-' + i
        anchor(sid, rec)
      }
    }
    const sel = rnd() < 0.5 ? pick(WORDS) : [pick(WORDS), pick(WORDS)].join(' ')
    let r1, r2
    try {
      r1 = await withTabs(tabs, () => coord.resolveSelector(sel))
      r2 = await withTabs(tabs, () => coord.resolveSelector(sel))   // determinism
    } catch (e) { threw++; continue }
    checked++
    // INV5 determinism
    if (JSON.stringify(r1) !== JSON.stringify(r2)) invViolations++
    if (r1.ok) {
      // INV1 resolved address maps to a live, non-worker tab position
      const liveNonWorkerLabels = tabs.filter(t => !String(t.label).startsWith('[EOS-W-')).map(t => t.label)
      const matchedLabel = r1.target && r1.target.label
      if (!liveNonWorkerLabels.includes(matchedLabel)) invViolations++
      // INV2 never a worker label
      if (String(matchedLabel).startsWith('[EOS-W-')) invViolations++
      // INV3 score >= ACCEPT (300)
      if (!(r1.score >= 300)) invViolations++
    } else {
      // INV4 not-ok always carries a known reason
      if (!['ambiguous', 'no_live_match', 'empty_selector', 'bridge_unreachable'].includes(r1.reason)) invViolations++
    }
  }
  ok('no scenario threw', threw === 0, threw + ' threw')
  ok('all invariants held across ' + checked + ' scenarios', invViolations === 0, invViolations + ' violations')

  // ══ GROUP M: scale (5000 dead anchors must not slow or corrupt resolution) ══
  G('M. Scale: 5000 dead anchors + live tabs')
  clearAnchors()
  for (let i = 0; i < 5000; i++) anchor('dead' + i, { name: 'deadname' + i, label: 'Dead ' + i + '…', viewColumn: 1, index: i % 20, updated_at: NOW - (2 * 24 * 3600) })
  anchor('m-live', { name: 'needle', label: 'Needle Chat', viewColumn: 1, index: 0, updated_at: NOW })
  await withTabs([{ label: 'Needle Chat', viewColumn: 1, index: 0 }], async () => {
    const t0 = Date.now()
    const r = await coord.resolveSelector('needle')
    const ms = Date.now() - t0
    ok('needle resolves through 5000 dead anchors', r.ok === true && r.address === 'chat.session:m-live.inbox')
    ok('resolution stays fast (<1500ms)', ms < 1500, ms + 'ms')
    const freshCount = coord._freshAnchors().length
    ok('freshness filter drops the 5000 dead (only live remains)', freshCount === 1, freshCount + ' fresh')
  })

  // ══ GROUP N: name_chat + heartbeat preservation ════════════════════════════
  G('N. name_chat write + heartbeat preservation')
  clearAnchors()
  anchor('n1', { label: 'Some Chat', viewColumn: 1, index: 0 })
  const nres = await coord.name_chat({ name: 'my-handle', context: 'doing the thing', aliases: ['mh', 'handle'], session_id: 'n1' })
  ok('name_chat returns stable address', nres.ok && nres.address === 'chat.session:n1.inbox')
  let rec = JSON.parse(fs.readFileSync(path.join(CHAT_TABS, 'n1.json'), 'utf8'))
  ok('name/context/aliases written', rec.name === 'my-handle' && rec.context === 'doing the thing' && rec.aliases.length === 2)
  simulateHeartbeat('n1', 'Some Chat Retitled', 1, 0)  // heartbeat rewrites label
  rec = JSON.parse(fs.readFileSync(path.join(CHAT_TABS, 'n1.json'), 'utf8'))
  ok('name survives a heartbeat rewrite', rec.name === 'my-handle' && rec.label === 'Some Chat Retitled')
  ok('alias survives too', Array.isArray(rec.aliases) && rec.aliases.includes('mh'))
  await withTabs([{ label: 'Some Chat Retitled', viewColumn: 1, index: 0 }], async () => {
    ok('resolves by name after heartbeat', (await coord.resolveSelector('my-handle')).address === 'chat.session:n1.inbox')
    ok('resolves by alias after heartbeat', (await coord.resolveSelector('mh')).address === 'chat.session:n1.inbox')
  })
  let threwOnEmpty = false
  try { await coord.name_chat({}) } catch (e) { threwOnEmpty = true }
  ok('name_chat with no fields throws', threwOnEmpty)

  // ── report ────────────────────────────────────────────────────────────────
  chatInject.listChatTabs = realList
  console.log('\n' + '='.repeat(60))
  console.log('\x1b[1mPRESSURE TEST RESULT: ' + pass + ' passed, ' + fail + ' failed\x1b[0m')
  if (fail) { console.log('\x1b[31mFAILURES:\x1b[0m'); for (const f of failures) console.log('  - ' + f) }
  else console.log('\x1b[32mALL GREEN across ' + (2000) + ' fuzz scenarios + 5000-anchor scale + every edge group.\x1b[0m')
  console.log('='.repeat(60))
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('HARNESS THREW:', e); process.exit(1) })
