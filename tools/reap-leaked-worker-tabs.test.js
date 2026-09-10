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

// A PRODUCTION STABLE ID DATES ITS TAB, AND A FIXTURE THAT IGNORES THAT CANNOT
// EXERCISE THE 2026-09-11 CAUSALITY RULE.
//
// The bridge mints 'ttab_' + Date.now().toString(36) + '_' + seq + '_' + column
// (cursor-preview-extension/ide-bridge.js assignStableTabIds), so every live id
// decodes to the millisecond that tab's identity was minted, and every anchor on
// disk carries updated_at in WHOLE SECONDS (measured 2026-09-11: 0 of 2,611
// missing). reap-plan refuses a label-only claim whose clock it cannot read, so
// a fixture wanting the legacy label-only path has to mint its id and state its
// clock the way production does. Any fixture below that never reaches that path
// keeps its synthetic id, because changing it would prove nothing.
const mintTtab = (ms, tag) => 'ttab_' + ms.toString(36) + '_' + tag
const secs = (ms) => Math.floor(ms / 1000)
// The tab from C3 fire 29, 2026-09-10T17:30:22.887Z, decoded from the real
// ttab_mtvsz8rr_1_1 that took a 13-day-old anchor's tab_id.
const BORN = Date.parse('2026-09-10T17:30:22.887Z')

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
    // Minted id + a clock the anchor postdates: the legacy label-only path, on
    // the only shape production actually produces.
    tabs: [tab({ tabId: mintTtab(BORN, 'w1_1'), label: '[aaaa a leaked worker t…' })],
    anchors: [{ label: '[aaaa a leaked worker t…', tab_id: 'tab_w1', role: 'worker', session_id: 's1', updated_at: secs(BORN + 8000) }],
    rows: { tab_w1: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label')
})

// ── 3. Tier 2: the stable id reaps a tab tier 1 could not resolve. ───────────
ok('tier 2 (stable id + label corroboration) reaps where the anchor tier is ambiguous', () => {
  const L = '[bbbb a recurring cron b…'
  const rep = run({
    tabs: [tab({ tabId: mintTtab(BORN, 'w2_1'), label: L })],
    // Seven anchors wearing ONE label - the measured recurring-cron shape that
    // makes signal 4 drop the tab. All seven postdate the tab, so all seven are
    // admitted and the ambiguity this tier exists to survive is the real one
    // rather than an artefact of the 2026-09-11 clock refusal.
    anchors: Array.from({ length: 7 }, (_, i) => ({ label: L, tab_id: 'tab_fire' + i, role: 'worker', updated_at: secs(BORN + 1000 * i) })),
    rows: { tab_w2: row({ tab_handle: { tabId: mintTtab(BORN, 'w2_1'), sentinel_prefix: '[bbbb a recurring cron brief]' } }) },
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
// Both decode, because the bridge minted them: 2026-08-29T12:30:25.473Z and
// 16:40:50.378Z, 4h10m apart, which is the previous-fire gap the header names.
const LIVE_BORN = parseInt(LIVE_TTAB.split('_')[1], 36)
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
      // Both postdate the live tab's mint, so both are ADMITTED and collide.
      // Dating them earlier would refuse them on the clock and this guard would
      // read as intact while testing nothing.
      { label: CRON_LABEL, tab_id: 'tab_fireA', role: 'worker', session_id: 'sa', updated_at: secs(LIVE_BORN + 3000) },
      { label: CRON_LABEL, tab_id: 'tab_fireB', role: 'worker', session_id: 'sb', updated_at: secs(LIVE_BORN + 9000) },
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
    tabs: [tab({ tabId: mintTtab(BORN, 't1_1'), label: L })],
    anchors: [{ label: L, tab_id: 'tab_t1', role: 'worker', session_id: 's1', updated_at: secs(BORN + 5000) }],
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


// -- PART 6. THE UNSTAMPED HALF OF THE STALE-ANCHOR DEFECT. -------------------
//
// WHY (2026-09-11, lane C7). Part 4's filter refuses a stale anchor only when
// that anchor CARRIES a stable id. An anchor with no id skipped the test and
// kept an unqualified label-only claim, so the defect simply moved to the
// unstamped population: 508 of the 2,611 anchors on disk carry no stable id,
// and 65 of the 91 labels worn by more than one anchor have at least one.
//
// MEASURED 2026-09-10T17:30Z, C3 fire 29. The live handle ttab_mtvsz8rr_1_1
// (minted 17:30:22.887Z) resolved via anchor_exact_label to
// tab_1787938228880_a97dce1d, out of an anchor written 2026-08-28T17:30:46Z by
// the same cron THIRTEEN days earlier and carrying no tabId. It survived on
// luck: the 13-day-old registry row had already aged off disk (retention ~22h)
// so rows.get missed and no_registry_row preserved. Six live crons fire more
// often than daily, which puts a TERMINATED previous-fire row inside that
// window, and then every remaining belt reads the WRONG id, including the
// transcript belt that exists to catch exactly this.
//
// The fix is a causality test, not an age threshold: an anchor written before
// a tab's identity was minted cannot be a statement about that tab. Cases 6c
// and 6d are the half that makes it a rule rather than a blanket refusal.
const STALE_ANCHOR_AT = Date.parse('2026-08-28T17:30:46.000Z')   // 13 days back
const LIVE_TAB = mintTtab(BORN, 'mtvsz_1')                        // 17:30:22.887Z
const SWEEP_LABEL = '[8dc1 ledger safety swee…'
const SWEEP_SENTINEL = '[8dc1 ledger safety sweep]'
const staleAnchor = { label: SWEEP_LABEL, tab_id: 'tab_deadfire_8dc1', role: 'worker', session_id: 's_2026_08_28', updated_at: secs(STALE_ANCHOR_AT) }

ok('PART 6a: a 13-day-old UNSTAMPED anchor never claims this fire’s live tab', () => {
  const rep = run({
    tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
    // The only anchor on disk for this label. The live fire has not written its
    // own yet: that ~20s gap IS the window.
    anchors: [staleAnchor],
    rows: {
      // The dead fire's row, TERMINATED and still on disk. This is the half the
      // 17:30Z fire got lucky on, and it is what turns the defect into a close.
      tab_deadfire_8dc1: row({ tab_handle: { tabId: 'ttab_deadfire_1_1' } }),
      // The live fire, running right now under its own id.
      tab_livefire_8dc1: row({ terminated_at: null, tab_handle: { tabId: LIVE_TAB, sentinel_prefix: SWEEP_SENTINEL } }),
    },
    // AND THE LIVE TAB IS WRITING. Keyed on its OWN tab_id, which the stale
    // resolution never reaches, so this belt is blind pre-fix by construction.
    writers: { tab_livefire_8dc1: Date.now() },
  })
  assert.strictEqual(rep.candidates.length, 0,
    'WRONG CLOSE: a live worker tab became a reap candidate on a dead fire’s identity')
  assert.strictEqual(reasonFor(rep, LIVE_TAB), 'stable_id_claimed_by_a_live_worker',
    'and it must be preserved BECAUSE a live worker holds this stable id, not by luck downstream')
})

ok('PART 6b: the refusal is the ANCHOR TIER’s, and it says so in the report', () => {
  // Same stale anchor, but nothing downstream can resolve the tab either, so
  // the reported reason is the tier-1 refusal itself rather than a rescue.
  // Without this case 6a alone cannot tell the narrowing from a lucky tier 2.
  const rep = run({
    tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
    anchors: [staleAnchor],
    rows: {},
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, LIVE_TAB), 'anchor_predates_this_tab_identity')
  const entry = rep.preserved.find((x) => x.ttab === LIVE_TAB)
  assert.strictEqual(entry.label_only_refused, 1,
    'the refused claimant count rides to the durable record so the narrowing is legible')
})

ok('PART 6c: CONTROL, an unstamped anchor that POSTDATES the tab still reaps it', () => {
  // The rule must refuse a previous fire and nothing else. This is the genuine
  // leak the tool exists to collect: same shape, same label, same absence of a
  // stable id, and the only difference is that the anchor was written after
  // this tab had an identity. A fix that fails this is a blanket refusal
  // wearing a causality argument, and cases 6a and 6b would not notice.
  const rep = run({
    tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
    anchors: [Object.assign({}, staleAnchor, { tab_id: 'tab_thisfire_8dc1', updated_at: secs(BORN + 7000) })],
    rows: { tab_thisfire_8dc1: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1, 'the narrowing must not cost a real collection')
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label')
  assert.strictEqual(rep.candidates[0].tab_id, 'tab_thisfire_8dc1')
})

ok('PART 6d: CONTROL, a worker running for six hours is never refused on its age', () => {
  // The failure mode a naive epoch threshold on the RESOLVED tab_id would
  // introduce. Measured over the live corpus, an anchor trails its own tab's
  // mint by up to 22,259s (6.2h) because the anchor is refreshed across the
  // tab's life. A long-running worker's anchor can never predate its own tab,
  // so the causality test cannot reach it no matter how long it runs.
  const SIX_HOURS = 6 * 3600 * 1000
  const rep = run({
    tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
    anchors: [Object.assign({}, staleAnchor, { tab_id: 'tab_longrunner', updated_at: secs(BORN + SIX_HOURS) })],
    rows: { tab_longrunner: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1)
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label')
})

ok('PART 6e: CONTROL, second-granularity truncation does not refuse a live anchor', () => {
  // updated_at is stored in WHOLE SECONDS while the ttab carries milliseconds,
  // so a legitimate anchor reads up to 1s EARLY. Measured 2026-09-11: 138 of
  // the 2,103 stamped anchors sit up to 0.9s before their own mint from that
  // alone. A zero-slop comparison would refuse them and this tool would quietly
  // stop collecting.
  const rep = run({
    tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
    anchors: [Object.assign({}, staleAnchor, { tab_id: 'tab_truncated', updated_at: secs(BORN) - 1 })],
    rows: { tab_truncated: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 1, 'a 1s truncation lead is not a previous fire')
  assert.strictEqual(rep.candidates[0].via, 'anchor_exact_label')
})

ok('PART 6f: an anchor with no stable id and no usable clock is refused, not admitted', () => {
  // Fail-safe on the unknown. Every one of the 2,611 anchors on disk carries
  // updated_at, so this is the shape that appears only if the writer changes or
  // a record is truncated. It reports its own reason rather than resolving on
  // a label, because a label is what started all of this.
  const noClock = { label: SWEEP_LABEL, tab_id: 'tab_noclock', role: 'worker', session_id: 's_noclock' }
  for (const bad of [{}, { updated_at: 0 }, { updated_at: 'yesterday' }, { updated_at: null }, { updated_at: NaN }]) {
    const rep = run({
      tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
      // Built WITHOUT a clock rather than by overriding one, so the bare {} case
      // is genuinely absent instead of inheriting a valid stale timestamp.
      anchors: [Object.assign({}, noClock, bad)],
      rows: {},
    })
    assert.strictEqual(rep.candidates.length, 0, 'an unreadable clock must never admit a claim')
    assert.strictEqual(reasonFor(rep, LIVE_TAB), 'anchor_has_no_stable_id_and_no_usable_clock')
  }
})

ok('PART 6g: an unparseable stable id refuses the claim rather than trusting the label', () => {
  // If the bridge ever changes its id format, every label-only claim must fail
  // CLOSED and say so, not fall back to the join that produced the defect.
  const rep = run({
    tabs: [tab({ tabId: 'ttab_notanepoch_1_1', label: SWEEP_LABEL })],
    anchors: [Object.assign({}, staleAnchor, { tab_id: 'tab_x', updated_at: secs(BORN) })],
    rows: {},
  })
  assert.strictEqual(rep.candidates.length, 0)
  assert.strictEqual(reasonFor(rep, 'ttab_notanepoch_1_1'), 'anchor_has_no_stable_id_and_no_usable_clock')
})

ok('PART 6i: STATE THE FLOOR, a fire five minutes ago is still a previous fire', () => {
  // 6a through 6h all pin the MEASURED case, which is 13 days stale, and a
  // suite that only pins that passes happily with the slop widened to a week.
  // Caught by mutation M4 on 2026-09-11: ANCHOR_CLOCK_SLOP_MS = 7 days left all
  // eight green, because 13 days still clears a 7-day tolerance. The tolerance
  // exists to absorb the SECOND-granularity of updated_at and nothing else, so
  // the floor belongs in the suite as its own assertion rather than in a
  // constant nobody re-reads.
  //
  // Five minutes is deliberately far below today's tightest live cadence
  // (measured 2026-09-11: 180min, gmail-inbox-poll) because that number moves
  // the moment someone adds a cron and a test pinned to it would rot into a
  // false pass. Any slop wide enough to admit a five-minute-old fire is wrong
  // on any fleet.
  const FIVE_MIN = 5 * 60 * 1000
  const rep = run({
    tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
    anchors: [Object.assign({}, staleAnchor, { updated_at: secs(BORN - FIVE_MIN) })],
    rows: { tab_deadfire_8dc1: row({}) },
  })
  assert.strictEqual(rep.candidates.length, 0,
    'ANCHOR_CLOCK_SLOP_MS is wide enough to admit a previous fire: it absorbs ' +
    'clock granularity, measured at under one second, not a dispatch interval')
  assert.strictEqual(reasonFor(rep, LIVE_TAB), 'anchor_predates_this_tab_identity')
})

ok('PART 6h: MUTATION GATE, the stale anchor is refused by the CLOCK and nothing else', () => {
  // 6a asserts a preserved tab and 6b asserts a reason, and a suite can pass
  // both while the guard does nothing, because a tab with no resolution is
  // preserved anyway. This case pins the DISCRIMINATION: one fixture, one field
  // changed, opposite outcomes. Move the stale anchor's clock forward past the
  // tab's mint and the SAME anchor must win the join and hand back the SAME
  // dead tab_id that 6a refuses. If both halves agree, the rule is not reading
  // the clock and every case in Part 6 is measuring nothing.
  const fixture = (updated_at) => ({
    tabs: [tab({ tabId: LIVE_TAB, label: SWEEP_LABEL })],
    anchors: [Object.assign({}, staleAnchor, { updated_at: updated_at })],
    rows: { tab_deadfire_8dc1: row({}) },
  })
  const refused = run(fixture(secs(STALE_ANCHOR_AT)))
  const admitted = run(fixture(secs(BORN + 1000)))
  assert.strictEqual(refused.candidates.length, 0,
    'PRE-FIX BEHAVIOUR IS BACK: the 13-day-old anchor claimed a live tab')
  assert.strictEqual(reasonFor(refused, LIVE_TAB), 'anchor_predates_this_tab_identity')
  assert.strictEqual(admitted.candidates.length, 1,
    'FIXTURE BROKEN: this anchor cannot win the join even when its clock is valid, ' +
    'so the refusal above proves nothing about the clock')
  assert.strictEqual(admitted.candidates[0].tab_id, 'tab_deadfire_8dc1')
})

console.log('\n' + passed + ' passed (' + path.basename(__filename) + ')')
