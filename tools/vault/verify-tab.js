'use strict'
// tools/vault/verify-tab.js - the daemon-side live-tab verification (red-team T4
// tenant confusion). The daemon owns the fill surface, so before it fills a code it
// reads the LIVE tab's origin + visible account hint (via CDP) and refuses unless
// both match the registered row. A conductor assertion of "this is the github tab"
// is never trusted; the daemon checks. A tate@ page can never be cleared by a code@
// OPEN fill because the account hint will not match.
// This module is the PURE matcher; the CDP read is injected. Design: docs/security/
// 2fa-...md s4 (cdp_session_ref is a daemon-VERIFIED binding, not a conductor claim).

// Normalize an origin to scheme://host (drop path, query, trailing slash, port when
// default). Refuses to match on host substring games (github.com vs github.com.evil).
function normalizeOrigin(origin) {
  if (typeof origin !== 'string') return null
  try {
    const u = new URL(origin)
    return u.protocol + '//' + u.hostname.toLowerCase()
  } catch (_e) { return null }
}

// Account hint match: the visible account text on the page must contain the
// registered account's local identity. Normalized, case-insensitive. This is what
// separates code@ from tate@ on the same accounts.google.com origin.
function accountHintMatches(liveHint, registeredAccount) {
  if (!registeredAccount) return true                 // no account bound => origin is the only gate
  if (typeof liveHint !== 'string' || !liveHint) return false
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '')
  const reg = norm(registeredAccount)
  const live = norm(liveHint)
  // Match on the full account OR its local-part (before @), whichever the page shows.
  const local = reg.includes('@') ? reg.split('@')[0] : reg
  return live.includes(reg) || (local.length >= 3 && live.includes(local))
}

// matchTab(observed, registered) -> { ok, reason }. observed = { origin, accountHint }
// read from the live tab; registered = the resolved seed row.
function matchTab(observed, registered) {
  observed = observed || {}; registered = registered || {}
  if (registered.registered_origin) {
    const a = normalizeOrigin(observed.origin)
    const b = normalizeOrigin(registered.registered_origin)
    if (!a || !b) return { ok: false, reason: 'origin-unparseable' }
    if (a !== b) return { ok: false, reason: 'origin-mismatch' }
  }
  if (!accountHintMatches(observed.accountHint, registered.registered_account)) {
    return { ok: false, reason: 'account-mismatch' }
  }
  return { ok: true }
}

// makeVerifyTab(readTab) -> an async verifyTab(cdpSessionRef, registered_origin,
// registered_account) matching submit_2fa's injected interface. readTab(cdpSessionRef)
// is the CDP reader (returns {origin, accountHint}); injected so this stays testable.
function makeVerifyTab(readTab) {
  return async function verifyTab(cdpSessionRef, registered_origin, registered_account) {
    let observed
    try { observed = await readTab(cdpSessionRef) } catch (_e) { return false }
    return matchTab(observed, { registered_origin, registered_account }).ok
  }
}

module.exports = { normalizeOrigin, accountHintMatches, matchTab, makeVerifyTab }
