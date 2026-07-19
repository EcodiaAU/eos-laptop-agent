'use strict'
// tools/vault/registry.js - the vault's service->seed resolution + tier gate.
// The T4 (tier-escalation) defence from the red-team: tier is an immutable enum
// carried ON the seed row, written once at enrollment, NEVER inferred from a
// conductor-supplied string against a permissive default. resolveService returns
// exactly one (seed_id, tier, backend, registered_origin, registered_account)
// tuple via one shared normalization, and DENIES on zero or multiple matches
// (default-DENY). No denylist, no alias rows for GATED seeds.
// Design spec: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md (section 4).

const TIERS = Object.freeze({ OPEN: 'OPEN', GATED: 'GATED', EXCLUDED: 'EXCLUDED' })
const BACKENDS = Object.freeze(['totp', 'email_otp', 'sms_otp', 'backup_code', 'push_to_code'])

// One shared normalization for BOTH the seed lookup and the tier lookup, so the
// two can never diverge (the "fuzzy seed match + strict tier miss" attack).
function normalizeService(service) {
  if (typeof service !== 'string') return ''
  return service.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

// resolveService(service, rows) -> { ok, seed_id, tier, backend, registered_origin,
// registered_account } | { ok:false, reason }. rows is the registry (array of
// enrolled seed records). Default-DENY: exactly one exact-normalized match wins;
// zero or more-than-one DENIES. Any row under a GATED-domain account name that is
// somehow tagged OPEN is refused (belt-and-braces against a mis-tagged enrollment).
function resolveService(service, rows) {
  const key = normalizeService(service)
  if (!key) return { ok: false, reason: 'empty-service' }
  if (!Array.isArray(rows)) return { ok: false, reason: 'no-registry' }
  const matches = rows.filter(r => normalizeService(r.service) === key)
  if (matches.length === 0) return { ok: false, reason: 'no-match-default-deny' }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous-multiple-match-deny' }
  const r = matches[0]
  if (!Object.values(TIERS).includes(r.tier)) return { ok: false, reason: 'invalid-tier' }
  if (r.tier === TIERS.EXCLUDED) return { ok: false, reason: 'excluded-tier' }
  if (!BACKENDS.includes(r.backend)) return { ok: false, reason: 'invalid-backend' }
  // GATED-domain safety net: a seed whose account is on a known GATED domain
  // must be GATED, never OPEN, regardless of the stored tag.
  if (r.tier === TIERS.OPEN && isGatedDomainAccount(r.registered_account)) {
    return { ok: false, reason: 'gated-domain-account-tagged-open-refused' }
  }
  return {
    ok: true,
    seed_id: r.seed_id,
    tier: r.tier,
    backend: r.backend,
    registered_origin: r.registered_origin || null,
    registered_account: r.registered_account || null,
  }
}

// Accounts on these identities are crown-jewel GATED regardless of stored tier.
// tate@ Google + Bank Australia are the only GATED accounts per Tate 2026-07-17.
const GATED_ACCOUNT_HINTS = ['tate@ecodia.au', 'bankaust', 'bank australia', 'bankaustralia']
function isGatedDomainAccount(account) {
  if (typeof account !== 'string') return false
  const a = account.trim().toLowerCase()
  return GATED_ACCOUNT_HINTS.some(h => a.includes(h))
}

// requiresApproval - the single tier choke point, evaluated BEFORE backend
// selection. GATED demands out-of-band approval regardless of which backend
// would serve (TOTP, email, SMS, backup, push). Origin: red-team S5-vs-backend-4
// gate-bypass finding.
function requiresApproval(resolved) {
  return !!(resolved && resolved.ok && resolved.tier === TIERS.GATED)
}

module.exports = { TIERS, BACKENDS, normalizeService, resolveService, requiresApproval, isGatedDomainAccount }
