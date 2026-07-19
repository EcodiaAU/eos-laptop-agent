'use strict'
// tools/vault/otp-reader.js - channel-bound email/SMS OTP selection. The red-team
// T1 finding: v1 read "a code matching sender + recency" with NO binding to an
// actual login, so an attacker who triggered a login/recovery on the real service
// from their own machine could have the daemon read the code from code@/Twilio and
// hand it over = account takeover, no password. The fixes, all here as pure logic:
//   1. ALLOWLIST: (service -> inbox -> exact sender -> subject pattern), never a
//      whole-inbox recency scan.
//   2. WATERMARK: record the newest existing OTP timestamp on resolve ENTRY; accept
//      only a code arriving STRICTLY AFTER it (not a bare recency window).
//   3. CHANNEL-BIND: the daemon fills an OTP only for a login IT ITSELF launched on
//      the canonical CDP profile within maxAgeSeconds, correlated by a nonce/target.
// Codes are never returned to the conductor; the daemon fills them.
// Design: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md s6 backends-2/3.

// A message: { inbox, sender, subject, body, ts } (ts = epoch seconds).
// An allowlist entry: { service, inbox, sender, subjectPattern (RegExp or string), codeRegex? }

function matchesAllowlist(service, msg, allowlist) {
  const entry = (allowlist || []).find(e => e.service === service)
  if (!entry) return { ok: false, reason: 'no-allowlist-entry' }
  if (msg.inbox !== entry.inbox) return { ok: false, reason: 'inbox-mismatch' }
  if (String(msg.sender).toLowerCase() !== String(entry.sender).toLowerCase()) return { ok: false, reason: 'sender-mismatch' }
  const pat = entry.subjectPattern
  const subjOk = pat instanceof RegExp ? pat.test(msg.subject || '') : (msg.subject || '').includes(pat || '')
  if (!subjOk) return { ok: false, reason: 'subject-mismatch' }
  return { ok: true, entry }
}

// Only messages strictly newer than the watermark taken at resolve entry.
function isAfterWatermark(msgTs, watermark) {
  return typeof msgTs === 'number' && typeof watermark === 'number' && msgTs > watermark
}

// The daemon-initiated login is { service, nonce, launchedAt }. A resolve is only
// honoured if such a login exists, is for THIS service, and was launched within
// maxAgeSeconds. This is the channel-bind: no in-flight daemon login => refuse.
function correlateToLogin(service, inflightLogin, now, maxAgeSeconds) {
  if (!inflightLogin) return { ok: false, reason: 'no-daemon-initiated-login' }
  if (inflightLogin.service !== service) return { ok: false, reason: 'login-service-mismatch' }
  if (now - inflightLogin.launchedAt > maxAgeSeconds) return { ok: false, reason: 'login-stale' }
  return { ok: true }
}

function extractCode(body, codeRegex) {
  const re = codeRegex || /\b(\d{6,8})\b/
  const m = String(body || '').match(re)
  return m ? m[1] : null
}

// pickOtp - the orchestrator. Returns { ok, code } to FILL, or { ok:false, reason }.
// Enforces, in order: channel-bind, allowlist, watermark, single-flight (caller-held).
function pickOtp(args) {
  const { service, messages, allowlist, watermark, inflightLogin, now, maxAgeSeconds = 120 } = args || {}
  const corr = correlateToLogin(service, inflightLogin, now, maxAgeSeconds)
  if (!corr.ok) return corr
  // candidate messages that pass the allowlist AND arrived strictly after watermark
  const candidates = (messages || [])
    .filter(m => matchesAllowlist(service, m, allowlist).ok)
    .filter(m => isAfterWatermark(m.ts, watermark))
    .sort((a, b) => b.ts - a.ts)
  if (candidates.length === 0) return { ok: false, reason: 'no-fresh-allowlisted-code' }
  const entry = matchesAllowlist(service, candidates[0], allowlist).entry
  const code = extractCode(candidates[0].body, entry && entry.codeRegex)
  if (!code) return { ok: false, reason: 'no-code-in-body' }
  return { ok: true, code, ts: candidates[0].ts }
}

module.exports = { matchesAllowlist, isAfterWatermark, correlateToLogin, extractCode, pickOtp }
