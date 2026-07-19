'use strict'
// tools/vault/submit-2fa.js - the vault daemon's ONE conductor-facing capability.
// The corrected core primitive (red-team): the daemon FILLS the code into the
// verified login tab and returns only {status}. It NEVER returns a code, seed, or
// backup-code set to the conductor. This composes registry (tier choke point) +
// totp (code gen) + an injected seedStore (SE-wrapped seed load) + an injected
// fillFn (cdp.nativeFill into a daemon-verified tab). The SE and CDP pieces are
// interfaces so this composition is testable now and the native impls drop in at
// Phase 1/2. Design: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md s3-s5.

const registry = require('./registry')
const totp = require('./totp')

// submit2fa(input, deps) -> { status, challenge_id?, reason? }
//   input:  { service, cdpSessionRef, approvalToken? }
//   deps:   { rows, loadSeed(seed_id)->{secret,algorithm,digits,period}|null,
//             verifyTab(cdpSessionRef, registered_origin, registered_account)->bool,
//             fill(cdpSessionRef, code)->{ok},
//             budget: { allow(service)->{ok,reason}, recordResolve(service), freeze(service,reason) },
//             approvals: { validate(service, approvalToken)->bool, open(service, actionSummary)->challenge_id },
//             audit(event) , now()->seconds }
// status in: filled | approval_required | denied
async function submit2fa(input, deps) {
  input = input || {}
  deps = deps || {}
  const audit = deps.audit || (() => {})
  const now = deps.now || (() => Math.floor(Date.now() / 1000))
  const { service, cdpSessionRef, approvalToken } = input

  // 1. Resolve to exactly one row, or default-DENY.
  const r = registry.resolveService(service, deps.rows)
  if (!r.ok) { audit({ event: 'deny', service, detail: r.reason }); return { status: 'denied', reason: r.reason } }

  // 2. Budget / fail-closed freeze BEFORE any secret is touched (red-team T1 volume).
  if (deps.budget) {
    const b = deps.budget.allow(service)
    if (!b.ok) { audit({ event: 'deny', service, tier: r.tier, detail: 'budget:' + b.reason }); return { status: 'denied', reason: 'budget-' + b.reason } }
  }

  // 3. Tier choke point BEFORE backend selection (red-team S5-vs-backend gate bypass).
  if (registry.requiresApproval(r)) {
    const ok = deps.approvals && approvalToken && deps.approvals.validate(service, approvalToken)
    if (!ok) {
      const summary = `EcodiaOS wants to log into ${r.registered_account || service} now`
      const challenge_id = deps.approvals ? deps.approvals.open(service, summary) : null
      audit({ event: 'approval_request', service, tier: r.tier, detail: challenge_id })
      return { status: 'approval_required', challenge_id }
    }
    audit({ event: 'approved', service, tier: r.tier })
  }

  // 4. Verify the LIVE tab matches the registered origin + account (red-team T4
  //    tenant confusion). The daemon owns the fill surface; a conductor assertion
  //    is never trusted. A tate@ page can never be cleared by a code@ OPEN fill.
  if (typeof deps.verifyTab === 'function') {
    const good = await deps.verifyTab(cdpSessionRef, r.registered_origin, r.registered_account)
    if (!good) { audit({ event: 'deny', service, tier: r.tier, detail: 'tab-origin-account-mismatch' }); return { status: 'denied', reason: 'tab-mismatch' } }
  }

  // 5. Backend: for TOTP, generate the code INSIDE this process from the SE-loaded
  //    seed. The seed is loaded and used here and never leaves; only the filled
  //    status crosses back to the conductor.
  if (r.backend !== 'totp') {
    // email_otp / sms_otp / backup_code / push_to_code land in Phase 3 behind the
    // same choke point. Deny cleanly rather than pretend.
    audit({ event: 'deny', service, tier: r.tier, backend: r.backend, detail: 'backend-not-yet-wired' });
    return { status: 'denied', reason: 'backend-not-implemented:' + r.backend }
  }
  const seed = deps.loadSeed ? await deps.loadSeed(r.seed_id) : null
  if (!seed || !seed.secret) { audit({ event: 'deny', service, detail: 'seed-missing' }); return { status: 'denied', reason: 'seed-missing' } }
  const code = totp.totp(seed.secret, {
    time: now(), algorithm: seed.algorithm || 'sha1', digits: seed.digits || 6, step: seed.period || 30,
  })

  // 6. FILL, never return. The code goes into the verified tab; the conductor gets status only.
  const filled = deps.fill ? await deps.fill(cdpSessionRef, code) : { ok: false }
  if (deps.budget) deps.budget.recordResolve(service)
  if (!filled || !filled.ok) { audit({ event: 'deny', service, tier: r.tier, backend: 'totp', detail: 'fill-failed' }); return { status: 'denied', reason: 'fill-failed' } }
  audit({ event: 'fill', service, tier: r.tier, backend: 'totp' })
  return { status: 'filled' }
}

module.exports = { submit2fa }
