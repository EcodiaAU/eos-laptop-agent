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
// The invariant (for the SWEEP paths): a close may fire ONLY on a POSITIVE
// identity of a terminated worker - its own sentinel prefix, a sentinel/label-
// confirmed tabIndex, or an exact non-generic spawn label. The autotitle_
// fingerprint tier is a FUZZY guess that provably cannot tell an autotitled
// DEAD-worker tab from a human chat carrying the same topic words, so on the
// sweep paths it must NEVER close. It is downgraded to diagnostic-only there: it
// may still report what it WOULD have matched (for the leak-visibility log), but
// it can no longer OS-close a tab. Better to leak a cosmetic ghost worker tab
// than to close Tate's live chat.
//
// SELF-CLOSE CARVE-OUT (2026-08-15, Tate-authorised "full fix"). The above ban
// held even for coord.close_my_tab (the worker self-closing its OWN tab), which
// meant that once Claude Code's improved autotitler replaced the spawn sentinel
// with a clean brief summary ("Advance away-ops runbook v2") - now the COMMON
// case, not the exception - every positive tier missed and the only surviving
// resolver (the fingerprint) was banned, so worker tabs leaked by default. The
// dead-worker collision the 2026-07-21 ban prevents CANNOT arise on self-close:
// the worker is ALIVE and calling, so its OWN tab is still open and its CC
// autotitle is a summary of its OWN brief - it is therefore the natural top
// scorer for its own fingerprint. coord.js tier (d) only ever hands the guard a
// UNIQUE DECISIVE winner (pickByFingerprint refuses on any competing match ->
// leak, never wrong-close) and excludes any tab still carrying a DIFFERENT
// worker's sentinel. So on self-close the fuzzy tier is admitted; the conductor-
// label belt still protects the conductor tab, and every SWEEP path keeps the
// hard ban unchanged.
//
// Doctrine: coord-close-my-tab-self-close-admits-decisive-fuzzy-2026-08-15
// (carve-out) over coord-close-path-must-positive-id-worker-never-fuzzy-close-2026-07-21
// (still governs the sweep paths). Related: worker-tab-close-survives-autotitle-
// via-brief-fingerprint-2026-06-22, cc-truncates-tab-title-24-chars-...-2026-08-03.

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
//   3. fuzzy_fingerprint_refused_not_positive_id - a fuzzy match is not a positive
//      worker identity, so on the SWEEP paths it can never OS-close.
//
// SELF-CLOSE waives belts 1 and 3; belt 2 always applies.
//
// Belt 1 (active). Written for the ORPHAN SWEEP paths, where "this tab is
// focused" is real evidence it is a live human chat rather than a dead worker.
// On the SELF-close path that evidence is worthless: a worker calling
// close_my_tab is a tab making a tool call, so its focus state says nothing about
// whether it is a human chat. Originally belt 1 refused EVERY self-close (leaking
// ~50-200MB of webview per worker tab - the exact burn close_my_tab exists to
// prevent; two continuity workers hit this on 2026-07-22, 96655d81 + 00c3b66f);
// the 2026-07-22 fix admitted a POSITIVE self-close, and 2026-08-15 widens that
// to admit the self-close fuzzy tier too (see the file header). A tab asking to
// close ITSELF cannot be the misfire-onto-Tate's-chat that 2026-07-21 fixed:
// that cascade was a SWEEP resolving onto a tab that was never the caller.
//
// Belt 3 (fuzzy). On the SWEEP paths a fuzzy autotitle match NEVER closes (the
// 2026-07-21 dead-worker-vs-human-chat collision). On SELF-close it IS admitted:
// the worker is alive, its own tab is the top scorer for its own fingerprint, and
// coord.js tier (d) only forwards a UNIQUE DECISIVE winner. Do NOT weaken the
// SWEEP ban - that is the 2026-07-21 lesson and it stands. Doctrine:
// coord-close-my-tab-self-close-admits-decisive-fuzzy-2026-08-15 (self-close) +
// coord-close-path-must-positive-id-worker-never-fuzzy-close-2026-07-21 (sweeps)
// + status_board 21276370-ea9d-4806-bc06-1af4c67dfc1d (the original leak).
function evaluateClose(strategy, tab, conductor, opts) {
  tab = tab || {}
  const selfClose = !!(opts && opts.selfClose)
  // Belt 1: sweep-only. On self-close, focus carries no human-chat evidence.
  if (tab.active === true && !selfClose) {
    return { allow: false, reason: 'active_tab_protected' }
  }
  // Belt 2: always. A worker must NEVER close the registered conductor tab, even
  // claiming its own self-close (a fuzzy self-close that resolved onto the
  // conductor's chat is exactly what this stops).
  const tm = (conductor && conductor.title_match != null) ? String(conductor.title_match).trim() : ''
  if (tm && tab.label && String(tab.label) === tm) {
    return { allow: false, reason: 'conductor_label_protected' }
  }
  // Belt 3: sweep-only. Self-close admits the (upstream-decisive) fuzzy winner.
  if (isFuzzyStrategy(strategy) && !selfClose) {
    return { allow: false, reason: 'fuzzy_fingerprint_refused_not_positive_id' }
  }
  return { allow: true, reason: String(strategy || 'positive') }
}

module.exports = { isFuzzyStrategy, isPositiveStrategy, evaluateClose }
