'use strict'
// tools/vault/enrollment-attest.js - signed enrollment statements (WYSIWYS + origin
// authenticity). The phone has TWO Secure-Enclave keys: a KeyAgreement key that
// receives sealed passwords (see envelope.js), and a SIGNING key
// (SecureEnclave.P256.Signing) that signs the enrollment statement for each account.
//
// The statement binds, immutably and unforgeably: the service, the exact login
// ORIGIN, and the human-readable LABEL that will be shown at approval time. The host
// (and the conductor) can VERIFY a statement but can never FORGE one, because the
// signing private key never leaves the phone's Enclave. This closes:
//   - finding #3 (attacker-chosen origin): the origin is signed, not conductor-supplied.
//   - finding #5 (WYSIWYS gap): the approval label is the signed one, so an injected
//     conductor cannot show "GitHub" while unlocking the bank.
// Design: docs/security/vault-hardened-architecture-and-compliance-2026-07-17.md.
const crypto = require('crypto')

// Canonical, deterministic serialization so signer and verifier agree byte-for-byte.
// Fixed field order; reject unknown fields so nothing can be smuggled unsigned.
const FIELDS = ['v', 'service', 'origin', 'label', 'keyId']
function canonical(stmt) {
  if (!stmt || typeof stmt !== 'object') throw new Error('statement must be an object')
  for (const k of Object.keys(stmt)) if (!FIELDS.includes(k)) throw new Error('unknown field: ' + k)
  const obj = {}
  for (const f of FIELDS) {
    if (stmt[f] == null) throw new Error('missing field: ' + f)
    obj[f] = String(stmt[f])
  }
  return Buffer.from(JSON.stringify(obj, FIELDS), 'utf8')
}

// Import a P-256 public key given as base64 x963 (65 bytes, 0x04||X||Y) or raw (64).
function importPub(pubB64) {
  const b = Buffer.from(pubB64, 'base64')
  const point = b.length === 64 ? Buffer.concat([Buffer.from([0x04]), b]) : b
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('bad public key encoding')
  return crypto.createPublicKey({ key: derSpkiFromP256Point(point), format: 'der', type: 'spki' })
}
// Wrap a raw P-256 point in the fixed SPKI DER prefix so Node can import it.
function derSpkiFromP256Point(point65) {
  const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
  return Buffer.concat([prefix, point65])
}

// verifyEnrollment(phoneSigningPubB64, statement, signatureB64) -> boolean.
// signature is DER ECDSA over sha256(canonical(statement)). Never throws on a bad
// signature (returns false); throws only on a malformed statement (a bug, not an attack).
function verifyEnrollment(phoneSigningPubB64, statement, signatureB64) {
  const msg = canonical(statement)
  const pub = importPub(phoneSigningPubB64)
  try {
    return crypto.verify('sha256', msg, { key: pub, dsaEncoding: 'der' }, Buffer.from(signatureB64, 'base64'))
  } catch (_e) { return false }
}

// --- test/simulator helper: stand in for the phone's SE signing key ---
function newSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const raw = publicKey.export({ format: 'der', type: 'spki' })
  const point = raw.subarray(raw.length - 65)             // last 65 bytes = 0x04||X||Y
  return {
    publicX963B64: point.toString('base64'),
    sign(statement) {
      return crypto.sign('sha256', canonical(statement), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    },
  }
}

module.exports = { canonical, verifyEnrollment, newSigner, importPub }
