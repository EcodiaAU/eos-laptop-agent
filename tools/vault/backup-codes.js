'use strict'
// tools/vault/backup-codes.js - two-phase lease/confirm for durable backup codes.
// Red-team T1/T5: backup codes are DURABLE secrets (valid until used). v1 burned
// on hand-out, so a vendor 2FA-page reshape that made the fill miss caused the
// honest conductor to re-call, burning the next code each time until the finite
// set drained and a passkey-only account locked with Tate away. The fix: LEASE a
// code (not consumed), fill it, and only CONSUME on confirmed login. A leased-but
// -unconfirmed code is RE-OFFERED, never discarded. Codes are never returned to
// the conductor; the daemon fills them. This module manages the state machine
// over a code list (SE-ciphertext in vault_backup_code in the real daemon).
// Design: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md s6 backend-4.

const LOW_WATER = 2   // alarm Tate + surface regeneration runbook at <= this many unused

// createBackupCodes(codes, opts) where codes is [{id, value?}] (value opaque here;
// the daemon holds ciphertext). opts.onLow(remaining) fires once when remaining
// crosses LOW_WATER downward.
function createBackupCodes(codes, opts) {
  opts = opts || {}
  const lowWater = opts.lowWater == null ? LOW_WATER : opts.lowWater
  const onLow = opts.onLow || (() => {})
  // state per id: 'unused' | 'leased' | 'consumed'
  const rows = (codes || []).map(c => ({ id: c.id, value: c.value, state: 'unused' }))
  let lowFired = false

  function remaining() { return rows.filter(r => r.state === 'unused').length }
  function leasedRow() { return rows.find(r => r.state === 'leased') || null }

  // lease() -> {id, value} | null. Re-offers an already-leased (unconfirmed) code
  // rather than burning a new one, so a retry after a missed fill does not drain
  // the set. Only advances to a NEW code once the prior lease is confirmed/released.
  function lease() {
    const already = leasedRow()
    if (already) return { id: already.id, value: already.value }   // re-offer, do not burn another
    const next = rows.find(r => r.state === 'unused')
    if (!next) return null
    next.state = 'leased'
    return { id: next.id, value: next.value }
  }

  // confirm(id) - the login was accepted; consume the leased code for good.
  function confirm(id) {
    const r = rows.find(x => x.id === id)
    if (!r || r.state !== 'leased') return { ok: false, reason: 'not-leased' }
    r.state = 'consumed'
    const rem = remaining()
    if (!lowFired && rem <= lowWater) { lowFired = true; try { onLow(rem) } catch (_e) {} }
    return { ok: true, remaining: rem }
  }

  // release(id) - the login was NOT confirmed (fill missed / user aborted). Return
  // the leased code to 'unused' so it is re-offered, never lost.
  function release(id) {
    const r = rows.find(x => x.id === id)
    if (!r || r.state !== 'leased') return { ok: false, reason: 'not-leased' }
    r.state = 'unused'
    return { ok: true }
  }

  function snapshot() { return rows.map(r => ({ id: r.id, state: r.state })) }

  return { lease, confirm, release, remaining, leasedRow, snapshot, LOW_WATER: lowWater }
}

module.exports = { createBackupCodes, LOW_WATER }
