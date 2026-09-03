'use strict'

// reap-plan - the PURE resolution + signal battery behind
// tools/reap-leaked-worker-tabs.js.
//
// It lives here, out of tools/, for two reasons. index.js autoloads every .js in
// tools/ and this file exports, so it would be required into the agent as a
// "tool" for no reason (the reaper itself stays export-free and keeps being
// skipped by the autoload content screen). And a planner that takes plain data
// and returns plain data is testable without an IDE bridge, which is the point:
// the wrong-close control below is only a control if it runs on every change,
// not once by hand on the day the tier was written.
//
// planReap(input) -> { candidates, preserved }
//   input.liveTabsIde  [{ tabId, label, index, viewColumn, active }]
//   input.anchors      chat-tabs records having BOTH label and tab_id, and
//                      OPTIONALLY tabId (the bridge's stable id, stamped by
//                      coord's _stampAnchorTabId). When present it is the join
//                      key and the label is only corroboration; see the tier 1
//                      note below for the cron collision that makes that
//                      necessary.
//   input.rows         Map<worker tab_id, registry row>
//   input.liveWriters  Map<worker tab_id, newest transcript turn ms>
//   input.conductor    the conductor registration
//   input.guard        tab-close-guard (injected so a test can see its refusals)
//   input.labelMatches (live, full) -> bool, truncation-aware. A UNIQUENESS
//                      test: full.startsWith(visible) only. Several call sites
//                      filter a whole tab list with it and refuse on more than
//                      one hit, so it stays strict and one-directional.
//   input.labelWears   (live, full) -> bool, the IDENTITY-strength variant
//                      (coord._labelWearsStored), which additionally accepts
//                      visible.startsWith(full). Used by tier 2 ONLY, where the
//                      subject is already a single known row. Defaults to
//                      labelMatches so an un-updated caller degrades to the old
//                      behaviour rather than to always-false.
//   input.ttm          tab-title-match, or null
//
// The tier design, the measured "ECodia site" wrong-close that shaped it, and
// which of the 7 numbered signals each tier stands in for are all documented in
// the header of tools/reap-leaked-worker-tabs.js. Read that first.

const GENERIC = new Set(['', 'claude code', 'new chat', 'cursor', 'chat', 'untitled'])
const isGeneric = (s) => GENERIC.has(String(s || '').trim().toLowerCase())

const DISPATCH_SENTINEL = /^\[[0-9a-f]{4}\s/
const wearsDispatchSentinel = (s) => DISPATCH_SENTINEL.test(String(s || ''))

function planReap(input) {
  const liveTabsIde = input.liveTabsIde || []
  const anchors = input.anchors || []
  const rows = input.rows || new Map()
  const liveWriters = input.liveWriters || new Map()
  const conductor = input.conductor || {}
  const guard = input.guard
  const ttm = input.ttm || null
  const labelMatches = input.labelMatches || (() => false)
  // NEVER `|| (() => false)` here. An always-false default silently disables a
  // whole tier, and the tier this one feeds is the only path a short-named
  // recurring cron tab has. Falling back to labelMatches costs the caller
  // today's behaviour, which is a miss; falling back to false costs it every
  // tier-2 collection, which is a regression.
  const labelWears = input.labelWears || labelMatches

  const report = { candidates: [], preserved: [] }

  // Signal 5 precomputed: everything a NON-terminated worker row claims.
  const liveClaimedTtab = new Set()
  const liveClaimedTabIds = new Set()
  for (const [id, row] of rows.entries()) {
    if (row.terminated_at) continue
    liveClaimedTabIds.add(id)
    const t = row.tab_handle && row.tab_handle.tabId
    if (t) liveClaimedTtab.add(t)
  }

  // Resolve each anchor to a live tab by EXACT label. Signal 1 and 4 both fall
  // out of this map: an anchor with several exact-label hits is not resolved,
  // and a live tab claimed by more than one anchor is dropped entirely.
  // THE ANCHOR'S OWN STABLE ID OUTRANKS ITS LABEL (2026-08-29 lane C5).
  //
  // The label was doing the whole job of the join, and a label is not unique
  // across fires of one cron. The dispatch sentinel is derived from the row's
  // task_id, Claude Code truncates the title at 24 chars, and every fire of one
  // cron therefore wears a BYTE-IDENTICAL label. So a dead fire's anchor matched
  // the live tab of the current fire and handed back the DEAD fire's tab_id.
  //
  // MEASURED 2026-08-29T16:41Z, and this is the probe that named the defect:
  // the live handle ttab_mtelxb62_1_1 resolved via=anchor_exact_label to
  // tab_1788006622530_7f429531, a tab_id that is not the calling tab and appears
  // nowhere in the 54-row worker registry. It came from
  // chat-tabs/455634df-....json, written 12:30:22Z by the PREVIOUS fire of that
  // same cron, carrying its own tabId ttab_mtecz9vl_1_1.
  //
  // THE FIX IS A FILTER, NOT A NEW MATCHER. An anchor that carries a tabId is
  // making a positive claim about WHICH tab it is, so it may only claim the tab
  // whose id it names. An anchor with no tabId keeps the label-only behaviour
  // unchanged, which is what the legacy corpus needs. Against the measured case:
  // the stale anchor names ttab_mtecz9vl_1_1, the live tab is ttab_mtelxb62_1_1,
  // no claim, tier 1 yields nothing, and tier 2 resolves the tab correctly off
  // the registry row's own stable id.
  //
  // ON RECOGNITION VS PERMISSION. This mostly REMOVES claims, and where it adds
  // one it is the stale-plus-fresh case: two anchors wear the label, only the
  // fresh one names this tab, so a pair that used to collapse to
  // 'multiple_anchors_claim_this_tab' now resolves to the LIVE fire's tab_id.
  // That is the intended outcome and it buys no permission: signals 2, 3, 5, 6
  // and 7 run afterwards from the one shared battery, unweakened.
  const byTtab = new Map()   // ttab id -> [{anchor, tab}]
  for (const a of anchors) {
    const exact = liveTabsIde.filter((t) => t.label === a.label && t.tabId)
    if (exact.length !== 1) continue
    const tab = exact[0]
    if (a.tabId && a.tabId !== tab.tabId) continue
    if (!byTtab.has(tab.tabId)) byTtab.set(tab.tabId, [])
    byTtab.get(tab.tabId).push({ anchor: a, tab: tab })
  }
  const conductorTabIds = new Set(['conductor'])
  if (conductor.tab_id) conductorTabIds.add(conductor.tab_id)

  // TIER 2 index: which worker rows claim which stable ttab id.
  const rowsByTtab = new Map()
  for (const [id, row] of rows.entries()) {
    const t = row.tab_handle && row.tab_handle.tabId
    if (!t) continue
    if (!rowsByTtab.has(t)) rowsByTtab.set(t, [])
    rowsByTtab.get(t).push({ id: id, row: row })
  }

  // ── RESOLUTION. Three tiers, then ONE shared signal battery. ─────────────
  // Every tab is resolved to at most one worker row here, or explicitly not
  // resolved. Nothing is closed in this pass; see the header for why tiers 2
  // and 3 replace signals 1 and 4 rather than weakening them.
  const resolved = new Map()   // ttab -> { tab, tab_id, via, anchor }
  const unresolved = []        // { tab, reason, extra }

  for (const tab of liveTabsIde) {
    if (!tab.tabId) continue
    const claims = byTtab.get(tab.tabId) || []

    // TIER 1 - exactly one exact-label anchor. Unchanged behaviour.
    if (claims.length === 1) {
      resolved.set(tab.tabId, {
        tab: tab, tab_id: claims[0].anchor.tab_id,
        via: 'anchor_exact_label', anchor: claims[0].anchor,
      })
      continue
    }
    // Carried so a tab that also fails tiers 2 and 3 still reports the reason
    // the anchor tier had for it, rather than a vaguer one.
    const tier1 = claims.length > 1
      ? { reason: 'multiple_anchors_claim_this_tab', extra: { claimants: claims.length } }
      : null

    // TIER 2 - the stable ttab id stored on the row, corroborated by the label.
    const byId = rowsByTtab.get(tab.tabId) || []
    if (byId.length > 1) {
      unresolved.push({ tab: tab, reason: 'multiple_rows_claim_this_stable_id', extra: { claimants: byId.length } })
      continue
    }
    if (byId.length === 1) {
      const th = byId[0].row.tab_handle || {}
      // A UNIQUENESS TEST WAS ANSWERING AN IDENTITY QUESTION (2026-09-03, lane C6).
      //
      // labelMatches is one-directional, full.startsWith(visible), and that is
      // correct where it is used to FILTER a whole tab list and refuse on more
      // than one hit. Tier 2 is not that question. It has already found exactly
      // ONE row by the tab's stable id and is only asking "is this one tab
      // wearing my name", which is identity-strength. The strict direction
      // answers that wrongly on the whole short-name population: Claude Code's
      // title window is 24 chars, so a sentinel SHORTER than 24 renders as the
      // whole sentinel plus a newline and spillover, the visible string is
      // LONGER than the stored one, and full.startsWith(visible) is false.
      // Measured 2026-09-03T03:03Z on the live pair, tab ttab_mtkxtb18_1_1
      // label "[aea4 gmail inbox poll]\n<U+2026>" against stored sentinel
      // "[aea4 gmail inbox poll]" (23 chars): strict false, wears true.
      // coord.js:2207-2219 records the corpus figure, 278 of 309 such labels
      // rejected over 1587 worker-role anchors, and names them "the short-named
      // recurring crons, the exact population the stable-id work exists to stop
      // leaking". The failure is fail-safe (line below preserves and CONTINUES,
      // so tier 3 never runs for it either) which is why it read as clean for
      // as long as it did: not a wrong close, a permanent leak.
      //
      // THE WEARS DIRECTION IS GATED, AND THE GATE IS THE LOAD-BEARING HALF.
      // Accepting visible.startsWith(full) unconditionally opens a wrong-close
      // path this tier exists to refuse. label_at_spawn is the literal string
      // "Claude Code" on 8 of 8 live worker rows (measured 2026-09-03T03:2xZ
      // over ~/.ecodiaos/coordination/workers/*.json), so an ungated swap would
      // corroborate ANY truncated tab titled "Claude Code<U+2026>" onto a
      // re-homed stable id, which is exactly the recycling case below. So the
      // wears direction is additive only, and only for a stored name that is a
      // real identity: non-generic, and at least as long as the shortest
      // visible prefix the strict path already trusts. That floor is symmetry,
      // not a new threshold: a strict match already implied
      // full.length >= visible.length >= _MIN_TRUNC_PREFIX, and the wears
      // direction is the ONLY path on which full can be the shorter side.
      const MIN_STORED_IDENTITY = 6   // mirrors coord.js _MIN_TRUNC_PREFIX
      const corroboratedBy = (full) => labelMatches(tab.label, full) || (
        !!full && !isGeneric(full) && String(full).length >= MIN_STORED_IDENTITY &&
        labelWears(tab.label, full)
      )
      const corroborated = corroboratedBy(th.sentinel_prefix) ||
                           corroboratedBy(th.label) ||
                           corroboratedBy(th.label_at_spawn)
      if (corroborated) {
        resolved.set(tab.tabId, { tab: tab, tab_id: byId[0].id, via: 'stable_tab_id', anchor: null })
      } else {
        // The recycling case: a stored id that outlived the tab it was minted
        // for and was re-homed onto whatever inherited the slot. Refuse.
        unresolved.push({ tab: tab, reason: 'stable_id_label_does_not_corroborate', extra: { row: byId[0].id } })
      }
      continue
    }

    // TIER 3 - fingerprint, gated on the dispatch sentinel. See header.
    if (!wearsDispatchSentinel(tab.label)) {
      unresolved.push(tier1
        ? { tab: tab, reason: tier1.reason, extra: tier1.extra }
        : { tab: tab, reason: 'no_anchor_no_row_and_no_dispatch_sentinel' })
      continue
    }
    const fpHits = []
    for (const [id, row] of rows.entries()) {
      const th = row.tab_handle || {}
      // A row that already names a DIFFERENT stable id is positively another
      // tab; it can never be this one.
      if (th.tabId && th.tabId !== tab.tabId) continue
      if (labelMatches(tab.label, th.sentinel_prefix)) { fpHits.push({ id: id, via: 'sentinel_prefix' }); continue }
      if (ttm && th.autotitle_fingerprint) {
        const r = ttm.pickByFingerprint([tab], th.autotitle_fingerprint, th.sentinel_prefix || null)
        if (r && r.match) fpHits.push({ id: id, via: 'autotitle_fingerprint' })
      }
    }
    // Reverse uniqueness. pickByFingerprint's own uniqueness check compares
    // CANDIDATE TABS for one fingerprint; here the many side is the ROWS, so
    // that check cannot fire and this one has to. Measured: 5 rows resolve to
    // the single live "[f0c9 status board execu\u2026" tab.
    if (fpHits.length === 1) {
      resolved.set(tab.tabId, { tab: tab, tab_id: fpHits[0].id, via: 'fingerprint:' + fpHits[0].via, anchor: null })
    } else if (fpHits.length > 1) {
      unresolved.push({ tab: tab, reason: 'multiple_rows_claim_this_label', extra: { claimants: fpHits.length } })
    } else {
      unresolved.push(tier1
        ? { tab: tab, reason: tier1.reason, extra: tier1.extra }
        : { tab: tab, reason: 'no_anchor_no_registry_row' })
    }
  }

  // Report what did NOT resolve, so a tab this tool cannot collect is visible
  // with a reason instead of silently absent. Before 2026-08-29 the report
  // listed only anchor-resolved tabs, which is how a structural blind spot
  // read as a clean run.
  for (const u of unresolved) {
    report.preserved.push(Object.assign(
      { ttab: u.tab.tabId, label: u.tab.label, tab_id: null, via: 'unresolved', reason: u.reason },
      u.extra || {}))
  }

  // ── THE SIGNAL BATTERY. One copy, every tier. ────────────────────────────
  for (const [ttab, r] of resolved.entries()) {
    const tab = r.tab
    const tabId = r.tab_id
    const note = (reason, extra) => report.preserved.push(Object.assign(
      { ttab: ttab, label: tab.label, tab_id: tabId, via: r.via, reason: reason }, extra || {}))

    if (conductorTabIds.has(tabId)) { note('conductor_tab'); continue }
    // Belt on top of tab-close-guard: the conductor's own registered stable id,
    // checked before anything else can reason about this tab.
    if (conductor.stable_tab_id && ttab === conductor.stable_tab_id) { note('conductor_stable_tab_id'); continue }
    if (r.anchor && r.anchor.role !== 'worker') { note('anchor_is_not_a_worker', { role: r.anchor.role || null }); continue }
    if (isGeneric(tab.label)) { note('generic_label_is_not_an_identity'); continue }
    if (liveClaimedTtab.has(ttab)) { note('stable_id_claimed_by_a_live_worker'); continue }
    if (liveClaimedTabIds.has(tabId)) { note('worker_row_is_not_terminated'); continue }

    const row = rows.get(tabId)
    if (!row) { note('no_registry_row'); continue }
    if (!row.terminated_at) { note('worker_row_is_not_terminated'); continue }
    if (liveWriters.has(tabId)) {
      note('wrote_a_transcript_turn_inside_the_window', {
        transcript_age_min: Math.round((Date.now() - liveWriters.get(tabId)) / 60000),
      })
      continue
    }
    // STRATEGY NAMING IS LOAD-BEARING, not cosmetic. tab-close-guard belt 3
    // refuses a FUZZY strategy on any sweep, and it recognises one by
    // isFuzzyStrategy = startsWith('autotitle'). A tier renamed to
    // 'reaper_fingerprint:autotitle_fingerprint' would sail straight past that
    // belt, which is the 2026-07-21 mass-close guard, and the rename would look
    // like tidying. So the fingerprint tier hands belt 3 its own honest name and
    // is refused there exactly as cowork.js's sweep is. It still RESOLVES, so
    // the tab now appears in the report as
    // close_guard:fuzzy_fingerprint_refused_not_positive_id - seen and refused
    // on policy, which is a different and more useful fact than invisible.
    const strategy = (r.via === 'fingerprint:autotitle_fingerprint')
      ? 'autotitle_fingerprint'
      : 'reaper_' + r.via
    const decision = guard.evaluateClose(strategy, {
      label: tab.label, active: tab.active, index: tab.index, viewColumn: tab.viewColumn,
      // 2026-08-29: belt 2 identifies the conductor by stable tab id first, so
      // hand it the id we already keyed this whole loop on.
      tabId: tab.tabId || ttab || null,
    }, conductor)
    if (!decision.allow) { note('close_guard:' + decision.reason); continue }

    report.candidates.push({
      ttab: ttab, tab_id: tabId, label: tab.label, via: r.via,
      viewColumn: tab.viewColumn, index: tab.index,
      session_id: r.anchor ? r.anchor.session_id : null,
      terminated_at: row.terminated_at,
      closed_tab_refused_reason: row.closed_tab_refused_reason || null,
    })
  }
  return report
}

module.exports = { planReap: planReap, isGeneric: isGeneric, wearsDispatchSentinel: wearsDispatchSentinel }
