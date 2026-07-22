'use strict'
// tab-close-guard.js - the single close-safety policy shared by every IDE-tab
// close path (coord.close_my_tab, cowork.kill_worker, cowork.cleanup_orphan_workers).
//
// Root cause it fixes (2026-07-21, third and complete fix). Tate keeps MANY
// human-named Claude Code chat tabs open in ONE IDE window - "Ecodia Site",
// "DayCrew", "Take3", "ST Site", "Marketing", "Budgetting"... Only ONE is
// `active` (focused) at a time. A completing worker's autotitle_fingerprint
// (the salient tokens of its brief) is scored against the live tabs; a human
// chat named after the SAME topic ("Ecodia Site" vs an ecodia-site worker's
// brief) clears the fingerprint bar (hits>=2, coverage>=0.6) as the unique
// decisive winner and gets CLOSED. The two prior 2026-07-21 fixes added an
// active-tab belt to kill_worker + cleanup, but that belt spares only the ONE
// focused tab; every backgrounded human chat stayed exposed. kill_worker fires
// on every worker completion (scheduler.markComplete -> completionPass ~5s) and
// every signal_bound-timeout orphan (~90s), so Tate's ecodia.au chat kept being
// closed "every ~1 min" while he worked on the site.
//
// The invariant: a close may fire ONLY on a POSITIVE identity of a terminated
// worker - its own sentinel prefix, a sentinel/label-confirmed tabIndex, or an
// exact non-generic spawn label. The autotitle_fingerprint tier is a FUZZY
// guess that provably cannot tell an autotitled dead-worker tab from a human
// chat carrying the same topic words, so it must NEVER close. It is downgraded
// to diagnostic-only: it may still report what it WOULD have matched (for the
// leak-visibility log), but it can no longer OS-close a tab. Better to leak a
// cosmetic ghost worker tab than to close Tate's live chat.
//
// Doctrine: coord-close-path-must-positive-id-worker-never-fuzzy-close-2026-07-21.
// Supersedes the "active-tab belt is the decisive protection" framing in
// coord-kill-worker-needs-active-tab-guard-like-cleanup-2026-07-21 and
// coord-sweep-must-exempt-registered-conductor-tab-2026-07-21.

// A match strategy is FUZZY iff the tab was resolved via the autotitle
// fingerprint. Every such matchedBy string is 'autotitle_' + reason (see
// coord.close_my_tab tier d, cowork.kill_worker tier d) or the bare
// 'autotitle_fingerprint' strategy label used by cleanup_orphan_workers.
function isFuzzyStrategy(strategy) {
  return String(strategy || '').startsWith('autotitle')
}

// A strategy is POSITIVE iff it is a non-fuzzy, non-empty identity tier.
function isPositiveStrategy(strategy) {
  return !!String(strategy || '').length && !isFuzzyStrategy(strategy)
}

// Decide whether a resolved close target may actually be closed.
//   strategy   - how the tab was matched (matchedBy / strategy string)
//   tab        - the live tab object from the fresh ide.tabs() probe
//                { label, active, ... }
//   conductor  - the registered conductor row (may be null). Its title_match,
//                when a real non-empty string, names a protected tab by label.
//   opts       - { selfClose } - true ONLY on coord.close_my_tab, where the
//                caller IS the tab it is asking to close (SELF-only path, see
//                coord.js close_my_tab). kill_worker / cleanup_orphan_workers
//                pass nothing and keep the unconditional belts.
// Returns { allow: boolean, reason: string }.
//
// Three belts, in refuse-precedence order:
//   1. active_tab_protected              - the focused tab is never a dead orphan
//   2. conductor_label_protected         - the registered conductor tab, by label
//   3. fuzzy_fingerprint_refused_not_positive_id - the load-bearing belt: a fuzzy
//      match is not a positive worker identity, so it can never OS-close.
//
// Self-close exception to belt 1 (2026-07-22). The active belt was written for
// the ORPHAN SWEEP paths, where "this tab is focused" is real evidence it is a
// live human chat rather than a dead worker. On the SELF-close path that
// evidence is worthless: a worker calling close_my_tab is BY CONSTRUCTION the
// active tab, because it just made a tool call to get here (the tool's own
// contract says so). So belt 1 unconditionally refused every self-close, and
// each dispatched worker tab leaked at roughly 50-200MB of webview - the exact
// memory burn close_my_tab exists to prevent. Two continuity workers hit this
// independently on 2026-07-22 (96655d81 on sentinel_prefix, 00c3b66f on
// tabIndex+sentinel), confirming it refuses across positive tiers, not one.
// The exception is deliberately narrow: it requires a POSITIVE strategy, so a
// fuzzy autotitle match can never reach it (belt 3 still refuses that below),
// and belt 2 still protects the registered conductor. A tab asking to close
// ITSELF cannot be the misfire-onto-Tate's-chat that 2026-07-21 fixed, because
// that cascade was a sweep resolving onto a tab that was never the caller.
// Do NOT "fix" a future leak by weakening positive-ID matching - that is the
// 2026-07-21 lesson and it stands.
// Doctrine: coord-close-path-must-positive-id-worker-never-fuzzy-close-2026-07-21
// (belts) + status_board 21276370-ea9d-4806-bc06-1af4c67dfc1d (this leak).
function evaluateClose(strategy, tab, conductor, opts) {
  tab = tab || {}
  const selfClose = !!(opts && opts.selfClose)
  if (tab.active === true && !(selfClose && isPositiveStrategy(strategy))) {
    return { allow: false, reason: 'active_tab_protected' }
  }
  const tm = (conductor && conductor.title_match != null) ? String(conductor.title_match).trim() : ''
  if (tm && tab.label && String(tab.label) === tm) {
    return { allow: false, reason: 'conductor_label_protected' }
  }
  if (isFuzzyStrategy(strategy)) {
    return { allow: false, reason: 'fuzzy_fingerprint_refused_not_positive_id' }
  }
  return { allow: true, reason: String(strategy || 'positive') }
}

module.exports = { isFuzzyStrategy, isPositiveStrategy, evaluateClose }
