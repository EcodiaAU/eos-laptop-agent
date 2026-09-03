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
const labelWears = (live, full) => { try { return !!(full && coord._labelWearsStored(live, full)) } catch (e) { return false } }

const TERMINATED = '2026-08-29T04:00:00.000Z'
const CONDUCTOR = { tab_id: 'conductor', stable_tab_id: 'ttab_cond_1_1', title_match: 'CE Teams', ide_bridge_port: 1 }

const tab = (o) => Object.assign({ tabId: 'ttab_x_1_1', label: 'x', index: 3, viewColumn: 1, active: false }, o)
const row = (o) => Object.assign({ terminated_at: TERMINATED, tab_handle: {} }, o)
const run = (o) => planReap({
  liveTabsIde: o.tabs, anchors: o.anchors || [], rows: new Map(Object.entries(o.rows || {})),
  liveWriters: new Map(Object.entries(o.writers || {})), conductor: o.conductor || CONDUCTOR,
  guard: guard, ttm: ttm, labelMatches: labelMatches,
  // The harness must inject BOTH matchers. reap-plan defaults labelWears to
  // labelMatches, so a harness that passes only the strict one exercises the
  // pre-2026-09-03 behaviour while looking like it tests the current code, and
  // every short-sentinel fixture below would fail for the wrong reason.
  labelWears: o.labelWears || labelWears,
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

// -- 4b. THE SHORT-SENTINEL SHAPE. The population tier 2 was built for. -------
// Claude Code renders a chat title into a 24-char window. A sentinel LONGER
// than that is truncated mid-word and the live label is a strict prefix of the
// stored name, which case 3 above covers and which the strict matcher handles.
// A sentinel SHORTER than 24 chars is shown WHOLE, followed by a newline and
// whatever spills in from the brief, so the live string is LONGER than the
// stored one and full.startsWith(visible) is false. Tier 2 refused every one of
// them, pushed the tab to unresolved and CONTINUED, so tier 3 never ran for it
// either: a short-named recurring cron tab was uncollectable forever. Measured
// 2026-09-03T03:03Z on ttab_mtkxtb18_1_1, live "[aea4 gmail inbox poll]\n<U+2026>"
// against stored "[aea4 gmail inbox poll]" (23 chars). coord.js:2207-2219
// carries the corpus figure: 278 of 309 such labels rejected over 1587 anchors.
ok('tier 2 resolves a SHORT sentinel the tab wears whole (the recurring-cron leak)', () => {
  const STORED = '[bbbb short cron]'            // 17 chars, inside the 24-char window
  const LIVE = '[bbbb short cron]\n\u2026'       // shown whole, then spillover
  const fixture = {
    tabs: [tab({ tabId: 'ttab_short_1_1', label: LIVE })],
    rows: { tab_short: row({ tab_handle: { tabId: 'ttab_short_1_1', sentinel_prefix: STORED } }) },
  }
  // A fixture that passes both before and after the change pins nothing. Injecting
  // the STRICT matcher as labelWears reproduces the pre-fix code exactly, and it
  // must still refuse, or this case is not testing what its name says.
  const before = run(Object.assign({ labelWears: labelMatches }, fixture))
  assert.strictEqual(before.candidates.length, 0,
    'FIXTURE BROKEN: the strict matcher no longer refuses this shape, so this case ' +
    'no longer reproduces the 2026-09-03 leak')
  assert.strictEqual(reasonFor(before, 'ttab_short_1_1'), 'stable_id_label_does_not_corroborate')

  const rep = run(fixture)
  assert.strictEqual(rep.candidates.length, 1,
    'tier 2 must resolve a tab wearing its stored sentinel whole')
  assert.strictEqual(rep.candidates[0].via, 'stable_tab_id')
  assert.strictEqual(rep.candidates[0].tab_id, 'tab_short')
})

// -- 4c. THE GATE ON THE NEW DIRECTION. A generic stored name proves nothing. -
// visible.startsWith(full) is only an identity claim when `full` IS an identity.
// label_at_spawn is the literal string "Claude Code" on 8 of 8 live worker rows
// (~/.ecodiaos/coordination/workers/*.json, 2026-09-03), so an ungated wears
// swap would corroborate ANY truncated tab titled "Claude Code<U+2026>" onto a
// re-homed stable id. That is the recycling wrong-close of case 4, re-opened by
// the fix for case 4b. This is the case that keeps the gate honest: delete the
// isGeneric check in reap-plan and this fails.
ok('tier 2 refuses a recycled id corroborated only by a GENERIC label_at_spawn', () => {
  const rep = run({
    tabs: [tab({ tabId: 'ttab_gen_1_1', label: 'Claude Code somethi\u2026' })],
    rows: {
      tab_gen: row({ tab_handle: {
        tabId: 'ttab_gen_1_1',
        sentinel_prefix: '[dddd a completely different worker]',
        label_at_spawn: 'Claude Code',
      } }),
    },
  })
  assert.strictEqual(rep.candidates.length, 0,
    'a generic spawn label must never corroborate a stable id')
  assert.strictEqual(reasonFor(rep, 'ttab_gen_1_1'), 'stable_id_label_does_not_corroborate')
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

// ── THE 2026-08-29 LANE C5 ANCHOR-KEY COLLISION. ────────────────────────────
// The label was the tier-1 join key and a label is not unique across fires of
// one cron: the dispatch sentinel comes from the row's task_id, Claude Code
// truncates the title at 24 chars, so every fire renders a BYTE-IDENTICAL label.
// Measured live at 16:41Z: the handle ttab_mtelxb62_1_1 resolved
// via=anchor_exact_label to tab_1788006622530_7f429531, which is not the calling
// tab and is in no registry row, out of an anchor written 4h11m earlier by the
// PREVIOUS fire of that cron. The fixtures below are that exact shape.
const STALE_TTAB = 'ttab_mtecz9vl_1_1'   // the dead fire's stable id
const LIVE_TTAB = 'ttab_mtelxb62_1_1'    // the live fire's stable id
const CRON_LABEL = '[ea2e ecodiaos lane C3 r…'

ok('a stale same-label anchor from a dead cron fire loses to the live tab', () => {
  const rep = run({
    tabs: [tab({ tabId: LIVE_TTAB, label: CRON_LABEL })],
    // The ONLY anchor on disk bearing this label belongs to the dead fire and
    // names the dead fire's tab. This is the measured case: the current fire
    // wrote no anchor at all.
    anchors: [{ label: CRON_LABEL, tab_id: 'tab_deadfire', tabId: STALE_TTAB, role: 'worker', session_id: 'sdead' }],
    rows: {
      // The dead fire's row is stranded un-terminated, so winning the join with
      // it does REAL harm: the battery reads worker_row_is_not_terminated off
      // the wrong row and preserves a tab that is genuinely collectable.
      tab_deadfire: row({ terminated_at: null, tab_handle: { tabId: STALE_TTAB } }),
      tab_livefire: row({ tab_handle: { tabId: LIVE_TTAB, sentinel_prefix: '[ea2e ecodiaos lane C3 reap leaked worker tabs]' } }),
    },
  })
  assert.strictEqual(rep.candidates.length, 1,
    'the stale anchor won the label join and cost a collection')
  assert.strictEqual(rep.candidates[0].tab_id, 'tab_livefire',
    'resolved to the DEAD fire\'s tab_id: this is the 16:41Z measurement')
  assert.strictEqual(rep.candidates[0].via, 'stable_tab_id')
})

ok('CONTROL: an anchor whose stable id NAMES this tab still resolves by label', () => {
  const rep = run({
    tabs: [tab({ tabId: LIVE_TTAB, label: CRON_LABEL })],
    anchors: [{ label: CRON_LABEL, tab_id: 'tab_livefire', tabId: LIVE_TTAB, role: 'worker', session_id: 'slive' }],
    rows: { tab_livefire: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label',
    'narrowing the join must not break the case it was meant to keep')
  assert.strictEqual(rep.candidates[0].tab_id, 'tab_livefire')
})

ok('stale AND fresh anchors on one label: the fresh one wins outright', () => {
  const rep = run({
    tabs: [tab({ tabId: LIVE_TTAB, label: CRON_LABEL })],
    anchors: [
      { label: CRON_LABEL, tab_id: 'tab_deadfire', tabId: STALE_TTAB, role: 'worker', session_id: 'sdead' },
      { label: CRON_LABEL, tab_id: 'tab_livefire', tabId: LIVE_TTAB, role: 'worker', session_id: 'slive' },
    ],
    rows: { tab_livefire: row({}), tab_deadfire: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1,
    'two same-label anchors used to collapse to multiple_anchors_claim_this_tab')
  assert.strictEqual(rep.candidates[0].tab_id, 'tab_livefire')
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label')
})

ok('GUARD INTACT: two anchors with NO stable id on one label still refuse', () => {
  const rep = run({
    tabs: [tab({ tabId: LIVE_TTAB, label: CRON_LABEL })],
    anchors: [
      { label: CRON_LABEL, tab_id: 'tab_fireA', role: 'worker', session_id: 'sa' },
      { label: CRON_LABEL, tab_id: 'tab_fireB', role: 'worker', session_id: 'sb' },
    ],
    rows: { tab_fireA: row({}), tab_fireB: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 0,
    'an anchor carrying no stable id must keep the label-only behaviour, ambiguity included')
  assert.strictEqual(reasonFor(rep, LIVE_TTAB), 'multiple_anchors_claim_this_tab')
})

// ── PART 5. THE INSTRUMENT. Making the fix OBSERVABLE from the durable record.
//
// WHY (2026-09-03, lane C6 second verify pass). b826db9 is correct and its unit
// cases pass, but two consecutive production fires of
// cowork.ecodiaos-lane-C3-reap-leaked-worker-tabs (07:15:17Z and 11:20:58Z)
// resolved EVERY tab at tier 1 (anchor_exact_label), so the fixed tier-2 branch
// was never exercised and its production gate stayed open. Both passes had to
// recover the per-tab `via` from a worker transcript in ~/.claude/projects,
// because the JSONL sink keeps counts and preserved_reasons only and
// stable_id_claimed_by_a_live_worker fits every tier equally. Forward exposure
// is thin (34 of 1656 worker anchors wear a whole short sentinel the strict
// matcher rejects, 2.1 pct), so a third wait is a worse instrument than
// recording the answer. wears_rescued marks the tab the NEW branch rescued;
// summariseResolution folds it and the tier histogram into the durable line.
const { summariseResolution } = require('./_lib/reap-plan')

ok('PART 5a: a tab the WEARS branch rescued is flagged wears_rescued', () => {
  const STORED = '[bbbb short cron]'          // 17 chars, inside the 24-char window
  const LIVE = '[bbbb short cron]\n…'     // shown whole, then spillover
  const rep = run({
    tabs: [tab({ tabId: 'ttab_short_1_1', label: LIVE })],
    rows: { tab_short: row({ tab_handle: { tabId: 'ttab_short_1_1', sentinel_prefix: STORED } }) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'stable_tab_id')
  assert.strictEqual(rep.candidates[0].wears_rescued, true,
    'the strict matcher refused this shape, so the flag must say the wears branch carried it')
  assert.strictEqual(summariseResolution(rep).wears_rescued_count, 1)
  assert.strictEqual(summariseResolution(rep).resolved_via.stable_tab_id, 1)
})

ok('PART 5b: a tab STRICT already corroborated is NOT flagged', () => {
  // Sentinel longer than the 24-char window, so the live label is a strict
  // prefix of the stored name and labelMatches answers on its own. The flag has
  // to stay off here or it counts the old path as the new one and the gate it
  // exists to close becomes unreadable.
  const STORED = '[cccc a long enough sentinel to be truncated]'
  const rep = run({
    tabs: [tab({ tabId: 'ttab_long_1_1', label: '[cccc a long enough sent…' })],
    rows: { tab_long: row({ tab_handle: { tabId: 'ttab_long_1_1', sentinel_prefix: STORED } }) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'stable_tab_id')
  assert.strictEqual(rep.candidates[0].wears_rescued, undefined,
    'a strict-corroborated tab must carry no flag at all, not a false one')
  assert.strictEqual(summariseResolution(rep).wears_rescued_count, 0)
})

ok('PART 5c: a tier-1 resolution counts under its own via and rescues nobody', () => {
  const L = '[dddd tier one anchor label]'
  const rep = run({
    tabs: [tab({ tabId: 'ttab_t1_1_1', label: L })],
    anchors: [{ label: L, tab_id: 'tab_t1', role: 'worker', session_id: 's1' }],
    rows: { tab_t1: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label')
  const sum = summariseResolution(rep)
  assert.strictEqual(sum.resolved_via.anchor_exact_label, 1)
  assert.strictEqual(sum.resolved_via.stable_tab_id, undefined)
  assert.strictEqual(sum.wears_rescued_count, 0,
    'THIS IS THE 07:15Z AND 11:20Z SHAPE: all tier 1, so the gate is vacuous, and ' +
    'the record must now say so rather than reading as a clean pass')
})

ok('PART 5d: an unresolved tab is counted, not dropped', () => {
  const rep = run({ tabs: [tab({ tabId: 'ttab_hum_1_1', label: 'COherence' })] })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(summariseResolution(rep).resolved_via.unresolved, 1)
})

ok('PART 5e: report.closed is NOT double-counted against candidates', () => {
  // The apply path pushes the SAME candidate object into report.closed. A
  // three-array sum would count every tab this tool actually collected twice,
  // which is exactly the population a later reader most cares about.
  const c = { via: 'stable_tab_id', wears_rescued: true }
  const sum = summariseResolution({ preserved: [], candidates: [c], closed: [c] })
  assert.strictEqual(sum.resolved_via.stable_tab_id, 1)
  assert.strictEqual(sum.wears_rescued_count, 1)
})

ok('PART 5f: a fail-safe refusal summarises without throwing', () => {
  // Four of the six exit paths call summarise on a report that never reached
  // planReap, so both arrays are empty or absent. The instrument outranks
  // nothing: if it throws here it takes out the refusal line, which is the one
  // record a silent healthy no-op cannot be told from a dead bridge without.
  for (const thin of [{}, { preserved: [], candidates: [] }, { preserved: null }]) {
    const sum = summariseResolution(thin)
    assert.deepStrictEqual(sum.resolved_via, {})
    assert.strictEqual(sum.wears_rescued_count, 0)
  }
})

ok('PART 5g: MUTATION GATE, the flag tracks the branch and not the outcome', () => {
  // Injecting the STRICT matcher as labelWears reproduces the pre-fix code, so
  // the short-sentinel tab must go back to being refused entirely. If it still
  // resolves, this whole Part is measuring nothing.
  const STORED = '[bbbb short cron]'
  const before = run({
    labelWears: labelMatches,
    tabs: [tab({ tabId: 'ttab_short_1_1', label: '[bbbb short cron]\n…' })],
    rows: { tab_short: row({ tab_handle: { tabId: 'ttab_short_1_1', sentinel_prefix: STORED } }) },
  })
  assert.strictEqual(before.candidates.length, 0)
  assert.strictEqual(reasonFor(before, 'ttab_short_1_1'), 'stable_id_label_does_not_corroborate')
  assert.strictEqual(summariseResolution(before).wears_rescued_count, 0)
  assert.strictEqual(summariseResolution(before).resolved_via.unresolved, 1)
})

console.log('\n' + passed + ' passed (' + path.basename(__filename) + ')')
