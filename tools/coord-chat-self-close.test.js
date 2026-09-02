'use strict'

// Regression test for the plain-chat self-close gap (board row 86b287cf, found
// 2026-08-29 when Tate told every open chat to resume and close its tab and one
// chat could not comply).
//
// THE DEFECT. close_my_tab resolved its target exclusively from a WORKER
// registry row, so a chat that was never dispatched had nothing to resolve and
// the call returned `tab_id required`. list_channels reported your_tab_id:null
// and list_workers include_dead=true carried no row for that chat's session, so
// the instruction was structurally unfollowable rather than merely unlucky.
//
// THE FIX. A plain chat DOES have a stable identity: the session anchor written
// by conductor_heartbeat on a genuine user turn, plus the _recent_active pointer
// that same turn rewrites. close_my_tab with no ctx.tab_id now resolves through
// that pair, corroborated by two independent signals (recent-active agreement
// and the resolved tab being the FOCUSED one), and REFUSES on every mismatch
// instead of falling through to a looser tier.
//
// Every refusal assertion below is PAIRED with a positive control on the same
// fixture, differing only in the variable under test. A refusal on a setup that
// could never have resolved anyway proves nothing. Doctrine:
// a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-chat-self-close.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-chat-selfclose-'))
process.env.COORD_ROOT = tmpRoot
const CHAT_TABS = path.join(tmpRoot, 'chat-tabs')
fs.mkdirSync(path.join(tmpRoot, 'conductors'), { recursive: true })
fs.mkdirSync(CHAT_TABS, { recursive: true })

const CONDUCTOR_LABEL = 'CONDUCTOR OWN CHAT'
const CONDUCTOR_TTAB = 'ttab_conductor_1_0'
fs.writeFileSync(
  path.join(tmpRoot, 'conductors', 'current.json'),
  JSON.stringify({
    tab_id: 'conductor',
    ide_bridge_port: 65535,
    title_match: CONDUCTOR_LABEL,
    stable_tab_id: CONDUCTOR_TTAB,
  })
)

const coord = require('./coord')
const ide = require('./ide')

const CC = 'mainThreadWebview-claudeVSCodePanel'

// The fixture: three open chats in one column. Index 0 is the registered
// conductor, 1 is our caller, 2 is a bystander human chat.
const CALLER_SESSION = 'aaaaaaaa-1111-2222-3333-444444444444'
const OTHER_SESSION = 'bbbbbbbb-5555-6666-7777-888888888888'
const CALLER_LABEL = 'Close the ecodia site c…'
const OTHER_LABEL = 'DayCrew invoices'

let LIVE_TABS = []
const closeCalls = []

// listChatTabs is the anchor-resolution space (label + viewColumn + index +
// isActive). ide.tabs is the close-coordinate space. Both are stubbed off ONE
// LIVE_TABS array so a test can never accidentally have them disagree.
coord._setChatInject({
  listChatTabs: async () => LIVE_TABS.map((t, i) => ({
    label: t.label, viewColumn: 1, index: i, isActive: !!t.active, tabId: t.tabId,
  })),
  injectTurn: async () => ({ ok: true }),
})
ide.tabs = async () => ({
  groups: [{
    viewColumn: 1,
    isActive: true,
    tabs: LIVE_TABS.map((t, i) => ({ viewType: CC, index: i, label: t.label, tabId: t.tabId })),
  }],
})
ide.tabs_close = async (req) => {
  closeCalls.push(req)
  const at = typeof req.tabIndex === 'number' ? LIVE_TABS[req.tabIndex] : null
  if (at && req.exactLabel && at.label !== req.exactLabel) {
    return { closed: 0, matched: 0, refused: 'exactLabel_mismatch' }
  }
  return { closed: at ? 1 : 0, matched: at ? 1 : 0 }
}

let fails = 0
function ok(name, cond, extra) {
  if (cond) { console.log('  PASS: ' + name) }
  else { console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); fails++ }
}

function nowS() { return Math.floor(Date.now() / 1000) }
function writeAnchor(sessionId, fields) {
  fs.writeFileSync(
    path.join(CHAT_TABS, sessionId + '.json'),
    JSON.stringify(Object.assign({ session_id: sessionId, role: 'conductor', updated_at: nowS() }, fields))
  )
}
function setRecentActive(sessionId, ageS) {
  fs.writeFileSync(
    path.join(CHAT_TABS, '_recent_active.json'),
    JSON.stringify({ session_id: sessionId, updated_at: nowS() - (ageS || 0) })
  )
}
// Restore the known-good fixture. Every negative case mutates exactly one thing
// off this baseline, so the paired control is always one line away.
function baseline() {
  LIVE_TABS = [
    { tabId: CONDUCTOR_TTAB, label: CONDUCTOR_LABEL, active: false },
    { tabId: 'ttab_caller_1_1', label: CALLER_LABEL, active: true },
    { tabId: 'ttab_other_1_2', label: OTHER_LABEL, active: false },
  ]
  for (const f of fs.readdirSync(CHAT_TABS)) fs.unlinkSync(path.join(CHAT_TABS, f))
  writeAnchor(CALLER_SESSION, { label: CALLER_LABEL, viewColumn: 1, index: 1 })
  writeAnchor(OTHER_SESSION, { label: OTHER_LABEL, viewColumn: 1, index: 2 })
  setRecentActive(CALLER_SESSION, 5)
  closeCalls.length = 0
}

;(async () => {
  console.log('\n== Part 1: the defect is gone, and the positive path actually closes ==')
  baseline()
  const unconfirmed = await coord.close_my_tab({}, {})
  ok('a plain chat calling with NO tab_id no longer gets "tab_id required"',
    !/tab_id required/.test(String(unconfirmed.error || '')), JSON.stringify(unconfirmed))
  ok('the recent-active chat closes itself',
    unconfirmed.closed === true, JSON.stringify(unconfirmed))
  ok('strategy names the unconfirmed tier',
    unconfirmed.strategy === 'chat_session_anchor_recent_active', String(unconfirmed.strategy))
  ok('the close targeted the CALLER tab, not a sibling',
    closeCalls.length === 1 && closeCalls[0].tabIndex === 1 && closeCalls[0].exactLabel === CALLER_LABEL,
    JSON.stringify(closeCalls))
  ok('the close carried the single-target race guard (exactLabel + viewType)',
    closeCalls[0].viewType === CC && !!closeCalls[0].exactLabel)

  baseline()
  const confirmed = await coord.close_my_tab({ session_id: CALLER_SESSION }, {})
  ok('an explicitly-confirmed session_id closes and is labelled as confirmed',
    confirmed.closed === true && confirmed.strategy === 'chat_session_anchor_confirmed',
    JSON.stringify(confirmed))
  baseline()
  const viaAddress = await coord.close_my_tab({ session_address: 'chat.session:' + CALLER_SESSION + '.inbox' }, {})
  ok('the session_address list_channels hands out is accepted verbatim',
    viaAddress.closed === true && viaAddress.session_id === CALLER_SESSION, JSON.stringify(viaAddress))

  console.log('\n== Part 2: it refuses rather than guessing ==')

  baseline()
  const wrongClaim = await coord.close_my_tab({ session_id: OTHER_SESSION }, {})
  ok('a claim naming a DIFFERENT session refuses (contradiction, not fallback)',
    wrongClaim.closed === false && /not_recent_active_session/.test(String(wrongClaim.refused)),
    JSON.stringify(wrongClaim))
  ok('and nothing was closed on that refusal', closeCalls.length === 0)

  baseline()
  setRecentActive(CALLER_SESSION, 3600)
  const stale = await coord.close_my_tab({}, {})
  ok('an UNCONFIRMED close refuses when _recent_active is stale',
    stale.closed === false && /recent_active_stale/.test(String(stale.refused)), JSON.stringify(stale))
  ok('and nothing was closed on that refusal', closeCalls.length === 0)
  // Paired control: the ONLY difference is the pointer age.
  const staleButClaimed = await coord.close_my_tab({ session_id: CALLER_SESSION }, {})
  ok('CONTROL: the same stale fixture DOES close when the caller asserts its id',
    staleButClaimed.closed === true, JSON.stringify(staleButClaimed))

  baseline()
  LIVE_TABS[1].active = false
  const unfocused = await coord.close_my_tab({ session_id: CALLER_SESSION }, {})
  ok('a resolved tab that is NOT focused refuses (ownership signal 2)',
    unfocused.closed === false && /resolved_tab_not_focused/.test(String(unfocused.refused)),
    JSON.stringify(unfocused))
  ok('and nothing was closed on that refusal', closeCalls.length === 0)

  baseline()
  // Two fresh anchors resolving onto one live position: a focus-race mis-capture.
  writeAnchor('cccccccc-9999-0000-1111-222222222222', { label: CALLER_LABEL, viewColumn: 1, index: 1 })
  const contested = await coord.close_my_tab({ session_id: CALLER_SESSION }, {})
  ok('a contested position refuses rather than picking one claimant',
    contested.closed === false && /position_contested/.test(String(contested.refused)),
    JSON.stringify(contested))

  baseline()
  // The anchor label no longer matches any live tab (Claude Code retitled it).
  LIVE_TABS[1].label = 'Something else entirely'
  const retitled = await coord.close_my_tab({ session_id: CALLER_SESSION }, {})
  ok('an anchor that no longer resolves uniquely refuses (better leak than wrong-close)',
    retitled.closed === false && /anchor_not_uniquely_resolvable/.test(String(retitled.refused)),
    JSON.stringify(retitled))
  ok('and nothing was closed on that refusal', closeCalls.length === 0)

  console.log('\n== Part 3: the registered conductor tab is excluded ==')
  baseline()
  // The conductor chat is itself the recent-active focused chat. role is NOT the
  // discriminator here (every plain-chat anchor carries role "conductor"), so
  // this proves the exclusion runs on the REGISTERED identity.
  const CONDUCTOR_SESSION = 'dddddddd-3333-4444-5555-666666666666'
  writeAnchor(CONDUCTOR_SESSION, { label: CONDUCTOR_LABEL, viewColumn: 1, index: 0 })
  setRecentActive(CONDUCTOR_SESSION, 5)
  LIVE_TABS[1].active = false
  LIVE_TABS[0].active = true
  const condClose = await coord.close_my_tab({ session_id: CONDUCTOR_SESSION }, {})
  ok('the registered conductor tab refuses to self-close',
    condClose.closed === false && /conductor_(stable_id|label)_protected/.test(String(condClose.refused)),
    JSON.stringify(condClose))
  ok('and nothing was closed on that refusal', closeCalls.length === 0)
  // Paired control: same shape, a non-conductor chat, closes.
  baseline()
  LIVE_TABS[1].active = false
  LIVE_TABS[2].active = true
  setRecentActive(OTHER_SESSION, 5)
  const bystander = await coord.close_my_tab({ session_id: OTHER_SESSION }, {})
  ok('CONTROL: an identically-shaped NON-conductor chat does close',
    bystander.closed === true && closeCalls.length === 1 && closeCalls[0].tabIndex === 2,
    JSON.stringify(bystander) + ' ' + JSON.stringify(closeCalls))

  console.log('\n== Part 4: a worker caller is untouched by any of this ==')
  baseline()
  coord._registerWorkerInternal({ tab_id: 'tab_9_worker', task_id: 'task-w', tab_credential: 'c' })
  const workerCall = await coord.close_my_tab({}, { tab_id: 'tab_9_worker' })
  ok('a worker caller still takes the worker path (never the chat path)',
    workerCall.tab_id === 'tab_9_worker'
      && !/chat_session_anchor/.test(String(workerCall.strategy || '') + String(workerCall.refused || '')),
    JSON.stringify(workerCall))
  ok('a worker with no stored handle still refuses rather than closing a human chat',
    workerCall.closed === false && closeCalls.length === 0, JSON.stringify(workerCall))

  // A worker's anchor must never be a chat-path target even if it somehow lands
  // in the recent-active pointer.
  baseline()
  writeAnchor('eeeeeeee-7777-8888-9999-000000000000',
    { label: CALLER_LABEL, viewColumn: 1, index: 1, role: 'worker', tab_id: 'tab_9_worker' })
  setRecentActive('eeeeeeee-7777-8888-9999-000000000000', 5)
  const workerAnchor = await coord.close_my_tab({ session_id: 'eeeeeeee-7777-8888-9999-000000000000' }, {})
  ok('a worker-role anchor is refused on the chat path',
    workerAnchor.closed === false && /anchor_is_worker_role/.test(String(workerAnchor.refused)),
    JSON.stringify(workerAnchor))

  console.log('\n== Part 5: input parsing ==')
  ok('bare session id passes through',
    coord._sessionIdFromInput(CALLER_SESSION) === CALLER_SESSION)
  ok('chat.session:<id>.inbox unwraps',
    coord._sessionIdFromInput('chat.session:' + CALLER_SESSION + '.inbox') === CALLER_SESSION)
  ok('session:<id> unwraps',
    coord._sessionIdFromInput('session:' + CALLER_SESSION) === CALLER_SESSION)
  ok('empty input is null', coord._sessionIdFromInput('') === null)

  console.log('')
  if (fails) { console.log('FAILED: ' + fails); process.exit(1) }
  console.log('ALL PASS')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
