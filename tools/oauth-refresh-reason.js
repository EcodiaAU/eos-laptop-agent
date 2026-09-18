// tools/oauth-refresh-reason.js
//
// The ONE classifier for why a Claude OAuth snapshot refresh failed. Two readers
// depend on it and they must never disagree:
//
//   daemons/cred-refresher.js decides whether a dead mark self-releases (transient)
//   or waits for the snapshot file to change (permanent).
//
//   ecodiaos backend scripts/account-failover-depth-canary.cjs tells a human which
//   of those two happened, and so whether to wait an hour or go and re-grant.
//
// Until 2026-09-18 the canary carried its own four-code copy (ENOTFOUND,
// ECONNREFUSED, ETIMEDOUT, EAI_AGAIN) while the daemon knew eleven. An account the
// daemon had marked dead on ECONNRESET or an HTTP 503 released itself inside the
// hour, while the canary told its reader that "only a new OAuth grant can" restore
// it. ISO lane E6, gap G10.
//
// SIDE-EFFECT FREE ON PURPOSE. No requires, no env reads, no disk. The canary
// loads this from the agent checkout, and cred-refresher.js cannot be required for
// that because it loads dotenv from the PRIVATE creds directory at module load.

'use strict'

// Transient: the network or the vendor is having a bad minute, and the same refresh
// token will work later. HTTP 429 joined on 2026-09-18 (E6 gap G9): a rate limit is
// the same failure 8f5da7f fixed for DNS, one status code over, and it used to fall
// through to the permanent default.
const TRANSIENT_REASON_RE = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|socket hang up|network|timed? ?out|HTTP 5\d\d|HTTP 429|Too Many Requests/i

// Permanent: the vendor rejected this refresh token or client. Tested FIRST.
const PERMANENT_REASON_RE = /invalid_grant|invalid_client|unauthorized_client|invalid_request|HTTP 40[0-3]/i

// An auth rejection is permanent on this machine by design, so it keeps the mtime
// latch even when its message happens to carry a transient-looking substring. That
// ordering is load-bearing: a vendor wording change must not be able to hand a spent
// refresh token an hourly retry. Anything matching NEITHER pattern is permanent too:
// an unknown failure costs a human a look, where a wrong transient costs a spent
// token an OAuth round trip every hour forever. Non-JSON bodies and TLS certificate
// errors stay here deliberately; 2,079 lines of daemon err log held none of either.
function isTransientReason(reason) {
  const s = String(reason || '')
  if (PERMANENT_REASON_RE.test(s)) return false
  return TRANSIENT_REASON_RE.test(s)
}

// The matched transient token (e.g. "ECONNRESET", "HTTP 503", "HTTP 429"), or null
// when the reason is not transient. Readers print it so a human sees WHICH fault.
function transientToken(reason) {
  const s = String(reason || '')
  if (!isTransientReason(s)) return null
  const m = s.match(TRANSIENT_REASON_RE)
  return m ? m[0] : null
}

// Turn a thrown request error into a reason string the classifier can read.
//
// err.message alone is not enough. Node 22 connects dual-stack (autoSelectFamily),
// and when every address fails it throws an AggregateError whose message is the
// EMPTY string, with the real cause on err.code and err.errors[]. Reproduced
// 2026-09-18 against localhost:1: name AggregateError, message "", code
// ECONNREFUSED. The daemon passed err.message, so a plain refused connection reached
// the classifier as "" and, on its third strike, would take the permanent latch by
// default. The err log holds seven failures with an empty reason, three of them one
// pass for all three accounts. All seven predate the first DEAD line, so none latched.
function describeRequestError(err) {
  if (!err) return 'unknown request error'
  if (typeof err !== 'object') return String(err)
  const parts = []
  if (err.message) parts.push(String(err.message))
  if (err.code && !parts.some(p => p.includes(String(err.code)))) parts.push(String(err.code))
  if (Array.isArray(err.errors)) {
    for (const e of err.errors) {
      const bit = e && (e.code || e.message)
      if (bit && !parts.some(p => p.includes(String(bit)))) parts.push(String(bit))
    }
  }
  if (!parts.length) parts.push(String(err.name || 'Error') + ' with no message or code')
  else if (!err.message && err.name) parts.unshift(String(err.name))
  return parts.join(' ')
}

module.exports = {
  TRANSIENT_REASON_RE,
  PERMANENT_REASON_RE,
  isTransientReason,
  transientToken,
  describeRequestError,
}
