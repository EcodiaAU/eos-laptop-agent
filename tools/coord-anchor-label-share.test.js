'use strict'

// The ownership guards around session anchors, and the ONE hole deliberately
// left open. Written from a live 2026-08-28 misroute: session d41af534's anchor
// had captured another chat's label AND position in a focus race, so a message
// addressed to d41af534 was injected into session 033c78ae.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-anchor-label-share.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-share-test-'))
process.env.COORD_ROOT = tmpRoot
const CT = path.join(tmpRoot, 'chat-tabs')
fs.mkdirSync(CT, { recursive: true })

const coord = require('./coord')
const chatInject = require('./chat-inject')
const NOW = Math.floor(Date.now() / 1000)

function anchor(sid, o) {
  fs.writeFileSync(path.join(CT, sid + '.json'),
    JSON.stringify(Object.assign({ session_id: sid, role: 'conductor', updated_at: NOW }, o)))
}
function clearAnchors() {
  for (const f of fs.readdirSync(CT)) fs.unlinkSync(path.join(CT, f))
}
const SHARED = 'Coord messaging still is…'
const A = '033c78ae-4414-4137-919a-62678e87960f'   // true owner
const B = 'd41af534-7dc3-4391-a1c7-1b4816c1ffc0'   // focus-race mis-capture

let passed = 0, failed = 0
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ' + JSON.stringify(extra) : '')) }
}
const resolve = (sid) => coord._resolveLiveTargetTab('chat.session:' + sid + '.inbox')

async function main() {
  // --- same label, SAME pinned position: the original conflict guard ---------
  chatInject.listChatTabs = async () => [
    { label: SHARED, viewColumn: 1, index: 9, isActive: false, groupActive: true },
    { label: 'Open my travel itinerary…', viewColumn: 1, index: 18, isActive: false, groupActive: true },
  ]
  clearAnchors()
  anchor(A, { label: SHARED, viewColumn: 1, index: 9 })
  anchor(B, { label: SHARED, viewColumn: 1, index: 9 })
  const a1 = await resolve(A), b1 = await resolve(B)
  ok('same label + same position: BOTH refuse rather than guess',
    a1.ok === false && b1.ok === false, { a: a1.reason, b: b1.reason })

  // --- same label, DIFFERENT pinned positions -------------------------------
  // The position-comparing conflict test is silent here: each anchor resolves a
  // different tab cleanly and neither sees the other, so a mis-capture wins its
  // pinned index unopposed. This is the hole the label-share guard closes.
  chatInject.listChatTabs = async () => [
    { label: SHARED, viewColumn: 1, index: 9, isActive: false, groupActive: true },
    { label: SHARED, viewColumn: 1, index: 10, isActive: false, groupActive: true },
  ]
  clearAnchors()
  anchor(A, { label: SHARED, viewColumn: 1, index: 10 })
  anchor(B, { label: SHARED, viewColumn: 1, index: 9 })
  const a2 = await resolve(A), b2 = await resolve(B)
  ok('same label + DIFFERENT positions: both refuse (label-share guard)',
    a2.ok === false && b2.ok === false, { a: a2.reason, b: b2.reason })
  ok('the refusal names label sharing, not a position conflict',
    b2.reason === 'session_label_shared_with_live_peer', b2.reason)

  // --- the guard must not break ordinary delivery ---------------------------
  // A too-strict guard turns every send into a silent queue, which is a worse
  // outcome than the misroute it prevents. Distinct labels must still resolve.
  chatInject.listChatTabs = async () => [
    { label: SHARED, viewColumn: 1, index: 9, isActive: false, groupActive: true },
    { label: 'Open my travel itinerary…', viewColumn: 1, index: 18, isActive: false, groupActive: true },
  ]
  clearAnchors()
  anchor(A, { label: SHARED, viewColumn: 1, index: 9 })
  anchor(B, { label: 'Open my travel itinerary…', viewColumn: 1, index: 18 })
  const a3 = await resolve(A), b3 = await resolve(B)
  ok('distinct labels still resolve (guard is not a blanket refusal)',
    a3.ok === true && b3.ok === true, { a: a3, b: b3 })

  // --- REGRESSION LOCK: a STALE same-label anchor must NOT veto -------------
  // A stale-claimant veto was built for the quiet-chat hole and reverted the
  // same turn: a resumed chat leaves its dead session's record behind, and that
  // record vetoed the live one. Observed live on "Open my travel itinerary"
  // (a 57-minute-old anchor from an earlier session of itself). Resumes are
  // common; a mis-capture of an idle chat's label is rare. Refusing every
  // resumed chat to catch it is the worse trade, so it must stay unguarded.
  clearAnchors()
  anchor(B, { label: 'Open my travel itinerary…', viewColumn: 1, index: 18 })
  anchor('aed3c46a-dead-dead-dead-deaddeaddead',
    { label: 'Open my travel itinerary…', viewColumn: 1, index: 18, updated_at: NOW - 57 * 60 })
  const b4 = await resolve(B)
  ok('a STALE same-label anchor does not veto a live chat (resume case)',
    b4.ok === true, b4)

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
