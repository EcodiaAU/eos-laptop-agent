'use strict'
// tools/vault/envelope.js - encrypt a secret TO an off-host public key.
// This is the cryptographic core of the boundary: the host seals a password to the
// recipient's PUBLIC key (the phone's Secure-Enclave key) and holds only the blob.
// Only the holder of the matching PRIVATE key (the phone, on Tate's Face ID) can
// open it. The host cannot open its own blobs - proven by envelope.test.js.
//
// Wire format is byte-identical to tools/vault/se/eos-vault-se.swift so a blob
// sealed here opens on the Secure Enclave and vice versa:
//   ECIES = ephemeral P-256 ECDH -> HKDF-SHA256 -> AES-256-GCM
//   blob  = ephemeralPub.x963(65 bytes) || iv(12) || ciphertext || tag(16)   (base64)
const crypto = require('crypto')

const SALT = Buffer.from('au.ecodia.vault.hkdf.v1', 'utf8')       // must match the Swift helper
const INFO = Buffer.from('eos-vault-se-ecies-p256-aesgcm', 'utf8')

// Accept a recipient public key as base64 of either the 65-byte x963 point
// (0x04||X||Y) or the 64-byte raw point (X||Y, what CryptoKit `rawRepresentation`
// emits). Returns the 65-byte uncompressed point Node's ECDH needs.
function toUncompressedPoint(pubB64) {
  const b = Buffer.from(pubB64, 'base64')
  if (b.length === 65 && b[0] === 0x04) return b
  if (b.length === 64) return Buffer.concat([Buffer.from([0x04]), b])
  throw new Error(`recipient public key must be 64 (raw) or 65 (x963) bytes, got ${b.length}`)
}

function hkdf32(sharedSecret) {
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, SALT, INFO, 32))
}

// sealTo(recipientPubB64, plaintext, aad?) -> base64 blob. No private key involved;
// the host can do this but can never reverse it. `aad` (the login origin) is bound
// as AES-GCM associated data: the blob is cryptographically tied to that origin, so
// a blob sealed for origin A CANNOT be opened for origin B (threat-model finding #3,
// attacker-chosen origin). The phone gets the origin from signed enrollment metadata,
// never from the conductor, and refuses to type into any other origin.
function sealTo(recipientPubB64, plaintext, aad) {
  const recipientPoint = toUncompressedPoint(recipientPubB64)
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const ephPub = ecdh.getPublicKey()                    // 65-byte x963
  const shared = ecdh.computeSecret(recipientPoint)     // 32-byte ECDH X coord
  const key = hkdf32(shared)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad != null) c.setAAD(Buffer.from(String(aad), 'utf8'))
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()])
  const tag = c.getAuthTag()
  return Buffer.concat([ephPub, iv, ct, tag]).toString('base64')
}

// openWith(recipientPrivateEcdh, blobB64) -> plaintext. Only callable by the holder
// of the private key. On the host this is used ONLY in tests (the host does not hold
// the private key in production - the phone does).
function openWith(ecdhWithPrivate, blobB64, aad) {
  const buf = Buffer.from(blobB64, 'base64')
  const ephPub = buf.subarray(0, 65)
  const iv = buf.subarray(65, 77)
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(77, buf.length - 16)
  const shared = ecdhWithPrivate.computeSecret(ephPub)
  const key = hkdf32(shared)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
  if (aad != null) d.setAAD(Buffer.from(String(aad), 'utf8'))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')   // throws if aad (origin) mismatches
}

// Helper for tests / the phone-simulator: make a P-256 keypair, return its ecdh
// object (holds the private key) + the public key in both encodings.
function newRecipient() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const x963 = ecdh.getPublicKey()                      // 65-byte
  return { ecdh, publicX963B64: x963.toString('base64'), publicRawB64: x963.subarray(1).toString('base64') }
}

module.exports = { sealTo, openWith, newRecipient, toUncompressedPoint }
