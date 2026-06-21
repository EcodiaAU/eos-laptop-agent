'use strict'
// Shared tab-title fingerprint matcher.
//
// Problem: Claude Code rewrites a chat tab's label a few seconds after spawn,
// summarising the first user message (the brief) into a short title. That
// overwrites the [EOS-W-xxxx] sentinel and the spawn-time label, so
// close_my_tab's identity tiers (tabIndex+confirm / sentinel_prefix /
// exact_label) all miss and the worker tab leaks.
//
// Insight: the auto-title is ALWAYS derived from the brief text, so a
// fingerprint of the brief's salient tokens recognises the auto-titled label
// with high precision. This module computes that fingerprint at spawn and, at
// close time, scores the live candidate tabs against it.
//
// Safety (this is the whole point): pickByFingerprint returns a match ONLY when
// exactly one candidate clears the confidence bar with a decisive margin over
// the runner-up. Ambiguity returns null -> close_my_tab refuses and leaks the
// tab rather than wrong-closing one of Tate's chats (the v3 mass-close incident
// that made "better leak than wrong-close" the invariant). A candidate that
// still carries a DIFFERENT worker's sentinel is positively someone else and is
// never eligible for fuzzy close.
//
// Used by:
//   cowork.js (spawn) -> computeFingerprint(briefBody) -> tab_handle.autotitle_fingerprint
//   coord.js  (close) -> pickByFingerprint(candidates, fp, ourSentinelPrefix)
//
// Doctrine: cc-auto-title-summarizer-strips-eos-w-sentinel-tabs-leak-2026-06-08.

// Generic English stopwords + structural dispatch-wrapper boilerplate that
// appears in EVERY brief and is never task-distinctive. Removing the wrapper
// words keeps the fingerprint biased toward the task, so a random title is less
// likely to score spurious hits.
const STOPWORDS = new Set((
  // generic english
  'the a an and or but for to of in on at by with from as is are be was were ' +
  'this that these those it its your you via per not no do does run use using ' +
  'into over than then if when must only all any new set get out up off we our i can ' +
  // dispatch-wrapper boilerplate (structural, shared by all workers)
  'worktree dispatched worker coord signal bound done terminate mandatory ' +
  'conductor tab credential brief paste action call first your you'
).split(/\s+/).filter(Boolean))

// Tokenise a string into salient lowercase tokens (alnum, length >= 3, non-stop).
function tokens(s) {
  if (!s) return []
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w))
}

// Build the fingerprint stored on the tab_handle. Bounded so the registry row
// stays small. `tokens` is a deduped set of the brief's salient tokens.
function computeFingerprint(briefBody) {
  const set = Array.from(new Set(tokens(briefBody)))
  return { v: 1, tokens: set.slice(0, 300) }
}

// Score one candidate label against the fingerprint token set.
//   hits     = number of label tokens present in the fingerprint
//   coverage = hits / (label token count)  -> how much of the title is "ours"
// If the label is truncated (ends with an ellipsis), the final token may be a
// prefix of a real brief token ("back" <- "backlog"), so allow a prefix hit on
// the last token only.
function scoreLabel(label, fpSet, truncated) {
  const lt = tokens(label)
  if (!lt.length) return { hits: 0, coverage: 0, total: 0 }
  let hits = 0
  for (let i = 0; i < lt.length; i++) {
    const w = lt[i]
    if (fpSet.has(w)) { hits++; continue }
    const isLast = (i === lt.length - 1)
    if (isLast && truncated && w.length >= 3) {
      for (const f of fpSet) { if (f.startsWith(w)) { hits++; break } }
    }
  }
  return { hits, coverage: hits / lt.length, total: lt.length }
}

const SENTINEL_RE = /^\s*(\[[^\]]+\])/
const TRUNC_RE = /(…|\.\.\.)\s*$/

// candidates: array of { label, ... } (CC chat tabs in the worker's viewColumn)
// fp:         the stored autotitle_fingerprint ({ tokens: [...] })
// ourSentinelPrefix: the worker's own sentinel ("[EOS-W-xxxx]") so we can tell
//             a still-sentinelled OTHER worker apart and never fuzzy-close it.
// Returns { match: <tab>|null, reason }.
function pickByFingerprint(candidates, fp, ourSentinelPrefix, opts) {
  opts = opts || {}
  const MIN_HITS = opts.minHits != null ? opts.minHits : 2
  const MIN_COVERAGE = opts.minCoverage != null ? opts.minCoverage : 0.6
  if (!fp || !Array.isArray(fp.tokens) || fp.tokens.length === 0) {
    return { match: null, reason: 'no_fingerprint' }
  }
  const fpSet = new Set(fp.tokens)
  const scored = []
  for (const t of (candidates || [])) {
    const label = t && t.label
    if (!label) continue
    // Exclude tabs still flagged with a DIFFERENT worker's sentinel: positively
    // identified as someone else, never eligible for fuzzy close.
    const m = label.match(SENTINEL_RE)
    if (m) {
      const sent = m[1]
      if (!ourSentinelPrefix || sent !== ourSentinelPrefix) continue
    }
    const truncated = TRUNC_RE.test(label)
    const s = scoreLabel(label, fpSet, truncated)
    if (s.hits >= MIN_HITS && s.coverage >= MIN_COVERAGE) {
      scored.push(Object.assign({ tab: t }, s))
    }
  }
  if (scored.length === 0) return { match: null, reason: 'no_candidate_cleared_bar' }
  scored.sort((a, b) => (b.hits - a.hits) || (b.coverage - a.coverage))
  if (scored.length > 1) {
    const top = scored[0], next = scored[1]
    // Strict uniqueness: top must beat the runner-up decisively, else refuse.
    const decisive =
      (top.hits - next.hits >= 2) ||
      (top.hits > next.hits && (top.coverage - next.coverage) >= 0.25)
    if (!decisive) {
      const dbg = scored.slice(0, 3).map(x => '"' + x.tab.label + '"(' + x.hits + '/' + x.total + ')').join(',')
      return { match: null, reason: 'ambiguous:' + dbg }
    }
  }
  const win = scored[0]
  return {
    match: win.tab,
    reason: 'fingerprint:hits=' + win.hits + '/' + win.total + ',cov=' + win.coverage.toFixed(2),
    score: { hits: win.hits, coverage: win.coverage, total: win.total },
  }
}

module.exports = { tokens, computeFingerprint, scoreLabel, pickByFingerprint, STOPWORDS }
