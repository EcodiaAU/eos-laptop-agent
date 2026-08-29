'use strict'

// The THIRD conductor-wake failure mode: conductor_unresolved on a tab that is
// alive, idle and correctly registered (2026-08-29).
//
// THE DEFECT. resolveLiveTargetTab resolved `conductor` through two tiers and
// both key on the tab TITLE: (i) an exact match against the stored title_match,
// (ii) a fingerprint of that same stored title. A title is not an identity.
// Claude Code retitles a chat as its conversation develops, and
// conductor_heartbeat only refreshes title_match on a genuine user turn whose
// single active non-worker tab is unambiguous (_active_chat_tab returns None on
// 0 or >1 candidates rather than clobber a good label with a guess). Under a
// busy fleet a freshly-spawned worker tab holds focus at the conductor's
// turn-start, so the refresh is skipped and the stored label rots while the tab
// itself is perfectly alive. The wake tier therefore decays exactly when the
// fleet is busiest, which is when a wake matters most.
//
// Measured live 2026-08-29T12:40Z on the running agent: the registration held
// title_match 'Whats cron posture sitti...' and fingerprint tokens
// [whats, cron, posture, sitti], while its OWN stable_tab_id ttab_mtecbdvm_1_1
// was live at viewColumn 1 index 16 wearing the label 'This is your context,
// an...'. Tier (i) matched 0 live tabs, tier (ii) returned
// no_candidate_cleared_bar, and _resolveLiveTargetTab returned
// conductor_unresolved. Reproduced in a FRESH process whose in-memory workers
// map was empty, so the non-worker pool was all 17 live tabs, the largest it
// can ever be: the failure is not worker-tab shadowing.
//
// THE FIX. Tier (iii), last resort: the bridge's stable ttab id, the only
// handle that survives a retitle AND a reorder, already stored on the
// registration and already the exclusive resolver for close_my_tab
// (coord-stable-tab-id-close.test.js). Ordered after the title tiers so it can
// only ever convert an outright conductor_unresolved into a resolution.
//
// Every refusal assertion below is PAIRED with a positive control on the same
// fixture, differing only in the variable under test. A refusal on a setup that
// could never have resolved anyway proves nothing. Doctrine:
// a-check-that-cannot-fail-is-not-a-check-run-it-on-a-known-good-control-2026-08-24.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-conductor-stable-tab-id-wake.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-conductor-stableid-'))
process.env.COORD_ROOT = tmpRoot
const CONDUCTORS = path.join(tmpRoot, 'conductors')
fs.mkdirSync(CONDUCTORS, { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'chat-tabs'), { recursive: true })

const coord = require('./coord')
const chatInject = require('./chat-inject')

// The live values measured 2026-08-29T12:40Z.
const STALE_TITLE = 'Whats cron posture sitti…'
const LIVE_TITLE = 'This is your context, an…'
const SID = 'ttab_mtecbdvm_1_1'

function register(o) {
  fs.writeFileSync(path.join(CONDUCTORS, 'current.json'), JSON.stringify(Object.assign({
    tab_id: 'conductor',
    ide: 'stable',
    title_match: STALE_TITLE,
    stable_tab_id: SID,
    title_fingerprint: { v: 1, tokens: ['whats', 'cron', 'posture', 'sitti'] },
    ide_bridge_port: 7457,
    workspace_root: '/Users/ecodia/.code/ecodiaos/backend',
    registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    in_turn: false,
  }, o)))
}
function tab(o) {
  return Object.assign({ tabId: null, label: 'x', viewColumn: 1, index: 0, isActive: false, groupActive: true }, o)
}
const setTabs = (arr) => { chatInject.listChatTabs = async () => arr }
const resolve = () => coord._resolveLiveTargetTab('chat.conductor.inbox')

let passed = 0, failed = 0
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')) }
}

async function main() {
  // === 1. THE LIVE DEFECT, replayed exactly ================================
  // The conductor tab retitled. Its stable id is unchanged and unique.
  const retitledFleet = [
    tab({ tabId: 'ttab_mted5a9i_1_1', label: '[c237 coord tab close la…', index: 10, isActive: true }),
    tab({ tabId: 'ttab_mtec9vxy_1_1', label: 'Crons', index: 4 }),
    tab({ tabId: 'ttab_mte7j5c5_1_1', label: 'Studio', index: 14 }),
    tab({ tabId: SID, label: LIVE_TITLE, index: 16 }),
  ]
  setTabs(retitledFleet)
  register({})
  const r1 = await resolve()
  ok('retitled conductor tab RESOLVES on its stable id', r1.ok === true, r1)
  ok('  and lands on the tab actually wearing that id', r1.ok === true && r1.label === LIVE_TITLE && r1.index === 16, r1)
  ok('  and reports which tier answered', r1.via === 'stable_tab_id', r1.via)

  // CONTROL for 1: same fleet, same stale title, but NO stable_tab_id stored.
  // This is the pre-fix code path. It must still fail, which proves assertion 1
  // was carried by the stable id and not by some other tier quietly matching.
  register({ stable_tab_id: undefined })
  const r1c = await resolve()
  ok('CONTROL no stored stable id on the same fleet: still conductor_unresolved',
    r1c.ok === false && r1c.reason === 'conductor_unresolved', r1c)

  // === 2. NO REGRESSION: a fresh title_match still wins tier (i) ============
  // The new tier is last resort, so a currently-resolving path must be untouched.
  setTabs([
    tab({ tabId: 'ttab_other_1_1', label: STALE_TITLE, index: 2 }),
    tab({ tabId: SID, label: LIVE_TITLE, index: 16 }),
  ])
  register({})
  const r2 = await resolve()
  ok('fresh exact title_match still wins ahead of the stable id',
    r2.ok === true && r2.label === STALE_TITLE && r2.via === undefined, r2)

  // CONTROL for 2: remove the title-matching tab and the stable id takes over,
  // proving the fixture could resolve either way and tier ORDER decided it.
  setTabs([tab({ tabId: SID, label: LIVE_TITLE, index: 16 })])
  const r2c = await resolve()
  ok('CONTROL drop the title match and the stable id answers instead',
    r2c.ok === true && r2c.via === 'stable_tab_id', r2c)

  // === 3. RECYCLING GUARD: an inherited id worn by a WORKER tab ============
  // assignStableTabIds pass 2 re-homes a prior id onto whatever tab inherits a
  // freed (viewColumn, index) slot, so a stored id can outlive its tab. A
  // conductor wake must never be routed into a dispatched worker.
  setTabs([
    tab({ tabId: SID, label: '[EOS-W-799a] wakesubstrate', index: 16 }),
    tab({ tabId: 'ttab_zzz_1_1', label: 'Messaging', index: 13 }),
  ])
  register({})
  const r3 = await resolve()
  ok('stable id inherited by a worker tab: REFUSE',
    r3.ok === false && r3.reason === 'conductor_unresolved', r3)

  // CONTROL for 3: byte-identical fixture, the sentinel prefix removed. If this
  // also refused, assertion 3 would be proving nothing about the worker guard.
  setTabs([
    tab({ tabId: SID, label: 'wakesubstrate notes', index: 16 }),
    tab({ tabId: 'ttab_zzz_1_1', label: 'Messaging', index: 13 }),
  ])
  const r3c = await resolve()
  ok('CONTROL same fixture minus the worker sentinel: resolves',
    r3c.ok === true && r3c.via === 'stable_tab_id', r3c)

  // === 4. DEAD ID: the tab is gone ==========================================
  setTabs([
    tab({ tabId: 'ttab_aaa_1_1', label: 'Crons', index: 4 }),
    tab({ tabId: 'ttab_bbb_1_1', label: 'Studio', index: 14 }),
  ])
  register({})
  const r4 = await resolve()
  ok('stored stable id matches no live tab: fails safe to the inbox',
    r4.ok === false && r4.reason === 'conductor_unresolved', r4)

  // CONTROL for 4: add the tab back, nothing else changed.
  setTabs([
    tab({ tabId: 'ttab_aaa_1_1', label: 'Crons', index: 4 }),
    tab({ tabId: SID, label: LIVE_TITLE, index: 16 }),
  ])
  const r4c = await resolve()
  ok('CONTROL put that tab back: resolves', r4c.ok === true && r4c.via === 'stable_tab_id', r4c)

  // === 5. NON-UNIQUE ID: refuse rather than guess ==========================
  // Two live tabs wearing one id means the id is no longer an identity.
  setTabs([
    tab({ tabId: SID, label: LIVE_TITLE, index: 16 }),
    tab({ tabId: SID, label: 'Some other chat', index: 17 }),
  ])
  register({})
  const r5 = await resolve()
  ok('two live tabs wear the stored id: REFUSE rather than guess',
    r5.ok === false && r5.reason === 'conductor_unresolved', r5)

  // CONTROL for 5: same two tabs, the second one re-homed to its own id.
  setTabs([
    tab({ tabId: SID, label: LIVE_TITLE, index: 16 }),
    tab({ tabId: 'ttab_distinct_1_1', label: 'Some other chat', index: 17 }),
  ])
  const r5c = await resolve()
  ok('CONTROL make the second id distinct: resolves', r5c.ok === true && r5c.via === 'stable_tab_id', r5c)

  // === 6. A bridge with no stable ids at all (pre-2026-08-23) ==============
  // tabId is null on every tab. A null-vs-null compare must never match.
  setTabs([
    tab({ tabId: null, label: 'Crons', index: 4 }),
    tab({ tabId: null, label: LIVE_TITLE, index: 16 }),
  ])
  register({ stable_tab_id: null })
  const r6 = await resolve()
  ok('old bridge, null ids on both sides: no null-matches-null resolution',
    r6.ok === false && r6.reason === 'conductor_unresolved', r6)

  // CONTROL for 6: same tabs, one carrying a real id the registration names.
  setTabs([
    tab({ tabId: null, label: 'Crons', index: 4 }),
    tab({ tabId: SID, label: LIVE_TITLE, index: 16 }),
  ])
  register({})
  const r6c = await resolve()
  ok('CONTROL give that tab a real id: resolves', r6c.ok === true && r6c.via === 'stable_tab_id', r6c)

  // === 7. The fingerprint tier still outranks the stable id ================
  // A live label the fingerprint genuinely matches must win, so the new tier
  // cannot mask a working tier-(ii) resolution.
  setTabs([
    tab({ tabId: 'ttab_fp_1_1', label: 'Whats cron posture sitting at…', index: 3 }),
    tab({ tabId: SID, label: LIVE_TITLE, index: 16 }),
  ])
  register({ title_match: 'no such label anywhere' })
  const r7 = await resolve()
  ok('a genuine fingerprint match still outranks the stable id',
    r7.ok === true && r7.via === undefined && r7.index === 3, r7)

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {}
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
