'use strict'
// Tests for the reaper's resolution tiers (tools/_lib/reap-plan.js).
//
// THE LOAD-BEARING ONE IS CASE 1. On 2026-08-29 lane C4 was briefed to add "an
// autotitle_fingerprint fallback for a live tab with no exact-label anchor".
// Run unguarded against the LIVE tab set that day, that fallback resolved Tate's
// human chat "ECodia site" onto terminated worker row
// tab_1787940177535_1ac7f80c (sentinel "[2c4b coexist refund notify deploy
// verif]") at hits=2/2 coverage=1.00, and that row was terminated, unclaimed and
// quiet, so it cleared every remaining signal and would have become a reap
// candidate. A two-token human title whose both tokens appear somewhere in a
// long brief is not distinguishable from a summary of that brief. The fixture
// below is that exact shape.
//
// The next person to touch this file will be told the same thing the brief said,
// because it is the obvious fix. This test is the reason they will not ship it.

const assert = require('assert')
const path = require('path')
const { planReap } = require('./_lib/reap-plan')
const guard = require('./tab-close-guard')
const ttm = require('./tab-title-match')
const coord = require('./coord')
const labelMatches = (live, full) => { try { return !!(full && coord._labelMatchesStored(live, full)) } catch (e) { return false } }

const TERMINATED = '2026-08-29T04:00:00.000Z'
const CONDUCTOR = { tab_id: 'conductor', stable_tab_id: 'ttab_cond_1_1', title_match: 'CE Teams', ide_bridge_port: 1 }

const tab = (o) => Object.assign({ tabId: 'ttab_x_1_1', label: 'x', index: 3, viewColumn: 1, active: false }, o)
const row = (o) => Object.assign({ terminated_at: TERMINATED, tab_handle: {} }, o)
const run = (o) => planReap({
  liveTabsIde: o.tabs, anchors: o.anchors || [], rows: new Map(Object.entries(o.rows || {})),
  liveWriters: new Map(Object.entries(o.writers || {})), conductor: o.conductor || CONDUCTOR,
  guard: guard, ttm: ttm, labelMatches: labelMatches,
})
const reasonFor = (rep, ttab) => (rep.preserved.find((p) => p.ttab === ttab) || {}).reason
let passed = 0
const ok = (name, fn) => { fn(); passed++; console.log('  ok  ' + name) }

// ── 1. THE CONTROL. A human chat that a fingerprint scores perfectly. ────────
ok('a human chat scoring 2/2 cov=1.00 on a terminated worker brief is NEVER a candidate', () => {
  const brief = 'Deploy the coexist refund notify verification for the ecodia site rollout, ' +
                'checking the refund webhook against the live ecodia site deployment.'
  const fp = ttm.computeFingerprint(brief)
  // Sanity: the fixture really does reproduce the measured wrong-close, or this
  // test proves nothing. A control that cannot fail is not a control.
  const scored = ttm.pickByFingerprint([tab({ label: 'ECodia site' })], fp, null)
  assert(scored.match, 'FIXTURE BROKEN: the fingerprint no longer matches "ECodia site" - ' +
    'rebuild the fixture so this test still reproduces the 2026-08-29 wrong-close (' + scored.reason + ')')

  const rep = run({
    tabs: [tab({ tabId: 'ttab_human_1_1', label: 'ECodia site', index: 9 })],
    rows: { 'tab_2c4b': row({ tab_handle: { sentinel_prefix: '[2c4b coexist refund notify deploy verif]', autotitle_fingerprint: fp } }) },
  })
  assert.strictEqual(rep.candidates.length, 0, 'WRONG-CLOSE: a human chat became a reap candidate')
  assert.strictEqual(reasonFor(rep, 'ttab_human_1_1'), 'no_anchor_no_row_and_no_dispatch_sentinel',
    'the human chat must be stopped by the dispatch-sentinel gate, before any scoring')
})

// ── 2. Tier 1 unchanged: one exact-label anchor still reaps. ─────────────────
ok('tier 1 (one exact-label anchor) reaps a terminated quiet worker', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w1_1_1', label: '[aaaa a leaked worker t…' })],
    anchors: [{ label: '[aaaa a leaked worker t…', tab_id: 'tab_w1', role: 'worker', session_id: 's1' }],
    rows: { tab_w1: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label')
})

// ── 3. Tier 2: the stable id reaps a tab tier 1 could not resolve. ───────────
ok('tier 2 (stable id + label corroboration) reaps where the anchor tier is ambiguous', () => {
  const L = '[bbbb a recurring cron b…'
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w2_1_1', label: L })],
    // Seven anchors wearing ONE label - the measured recurring-cron shape that
    // makes signal 4 drop the tab.
    anchors: Array.from({ length: 7 }, (_, i) => ({ label: L, tab_id: 'tab_fire' + i, role: 'worker' })),
    rows: { tab_w2: row({ tab_handle: { tabId: 'ttab_w2_1_1', sentinel_prefix: '[bbbb a recurring cron brief]' } }) },
  })
  assert.strictEqual(rep.candidates.length, 1, 'tier 2 must resolve a tier-1-ambiguous tab')
  assert.strictEqual(rep.candidates[0].via, 'stable_tab_id')
})

// ── 4. Tier 2 refuses a re-homed (recycled) stable id. ──────────────────────
ok('tier 2 refuses a stable id whose label does not corroborate (id recycling)', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w3_1_1', label: '[cccc some other tab en…' })],
    rows: { tab_w3: row({ tab_handle: { tabId: 'ttab_w3_1_1', sentinel_prefix: '[dddd a completely different worker]' } }) },
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_w3_1_1'), 'stable_id_label_does_not_corroborate')
})

// ── 5. Tier 3 sentinel: reaps once, refuses when two rows claim the label. ───
ok('tier 3 (sentinel prefix, no stored id) reaps a single claimant', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w4_1_1', label: '[eeee a worker with no …' })],
    rows: { tab_w4: row({ tab_handle: { sentinel_prefix: '[eeee a worker with no stored id]' } }) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'fingerprint:sentinel_prefix')
})
ok('tier 3 refuses when TWO rows claim one live tab (reverse ambiguity)', () => {
  const th = { sentinel_prefix: '[ffff one brief fired twice by a cron]' }
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w5_1_1', label: '[ffff one brief fired t…' })],
    rows: { tab_a: row({ tab_handle: th }), tab_b: row({ tab_handle: Object.assign({}, th) }) },
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_w5_1_1'), 'multiple_rows_claim_this_label')
})

// ── 6. The fuzzy tier resolves but belt 3 still refuses it. ─────────────────
ok('a fingerprint-only resolution is SEEN but refused by tab-close-guard belt 3', () => {
  const brief = 'Rebuild the murbpook dietary dropdown and reconcile the campout channelid mapping.'
  const rep = run({
    // Wears the dispatch sentinel (so the gate lets it through) but its label no
    // longer matches the stored sentinel, so only the fingerprint can claim it.
    tabs: [tab({ tabId: 'ttab_w6_1_1', label: '[9999 murbpook dietary d…' })],
    rows: { tab_w6: row({ tab_handle: { sentinel_prefix: '[9999 an entirely different spawn name]', autotitle_fingerprint: ttm.computeFingerprint(brief) } }) },
  })
  assert.strictEqual(rep.candidates.length, 0, 'belt 3 must still refuse a fuzzy sweep close')
  assert.strictEqual(reasonFor(rep, 'ttab_w6_1_1'), 'close_guard:fuzzy_fingerprint_refused_not_positive_id')
})

// ── 7. Signals 2, 3, 5 and the conductor belts survive the new tiers. ───────
ok('signal 5: a NON-terminated row is preserved even when tier 2 resolves it', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w7_1_1', label: '[1111 a live worker righ…' })],
    rows: { tab_w7: row({ terminated_at: null, tab_handle: { tabId: 'ttab_w7_1_1', sentinel_prefix: '[1111 a live worker right now]' } }) },
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_w7_1_1'), 'stable_id_claimed_by_a_live_worker')
})
ok('signal 3: a transcript turn inside the window preserves the tab', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w8_1_1', label: '[2222 terminated but sti…' })],
    rows: { tab_w8: row({ tab_handle: { tabId: 'ttab_w8_1_1', sentinel_prefix: '[2222 terminated but still writing]' } }) },
    writers: { tab_w8: Date.now() - 60000 },
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_w8_1_1'), 'wrote_a_transcript_turn_inside_the_window')
})
ok('the conductor\'s own stable tab id is refused before anything else reasons about it', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_cond_1_1', label: '[3333 conductor wearing …' })],
    rows: { tab_c: row({ tab_handle: { tabId: 'ttab_cond_1_1', sentinel_prefix: '[3333 conductor wearing a worker label]' } }) },
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_cond_1_1'), 'conductor_stable_tab_id')
})
ok('signal 1 preserved: an ACTIVE (focused) tab is never a candidate', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_w9_1_1', label: '[4444 focused right now …', active: true })],
    rows: { tab_w9: row({ tab_handle: { tabId: 'ttab_w9_1_1', sentinel_prefix: '[4444 focused right now and terminated]' } }) },
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_w9_1_1'), 'close_guard:active_tab_protected')
})
ok('a tab with no anchor and no registry row is reported, not silently invisible', () => {
  const rep = run({ tabs: [tab({ tabId: 'ttab_orphan_1_1', label: '[be52 coord tab close la…' })] })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_orphan_1_1'), 'no_anchor_no_registry_row')
})

console.log('\n' + passed + ' passed (' + path.basename(__filename) + ')')
