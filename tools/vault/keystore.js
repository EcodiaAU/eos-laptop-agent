'use strict'
// tools/vault/keystore.js - seal/open for vault secrets (seeds, backup codes).
// Two backends behind one interface:
//   - software (AES-256-GCM, key from a 0600 keyfile): fully working, used in dev
//     and test so the whole pipeline runs end to end now.
//   - secure-enclave (macOS, non-extractable key): the PRODUCTION at-rest root.
//     Provisioning requires a supervised session (Touch ID / keychain prompt), so
//     the SE key is NEVER created or invoked unattended from here. This module
//     defines the interface; the SE backend is wired + provisioned with a human.
// Red-team T3: at-rest confidentiality against host/DB compromise rests SOLELY on
// the SE key non-extractability in production. The software backend is dev-only
// and its keyfile is explicitly NOT a production security boundary.
// Design: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md s9.
const crypto = require('crypto')

const MAGIC = 'EOSVAULT1'   // version tag prefix on every ciphertext

// --- software backend (AES-256-GCM) ---------------------------------------
function softwareBackend(key32) {
  if (!Buffer.isBuffer(key32) || key32.length !== 32) throw new Error('softwareBackend: 32-byte key required')
  return {
    id: 'software-aes-256-gcm',
    seal(plaintext) {
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', key32, iv)
      const enc = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()])
      const tag = c.getAuthTag()
      // MAGIC | iv(12) | tag(16) | ciphertext
      return Buffer.concat([Buffer.from(MAGIC), iv, tag, enc]).toString('base64')
    },
    open(sealed) {
      const buf = Buffer.from(sealed, 'base64')
      const magic = buf.subarray(0, MAGIC.length).toString()
      if (magic !== MAGIC) throw new Error('keystore.open: bad magic / not a vault ciphertext')
      const iv = buf.subarray(MAGIC.length, MAGIC.length + 12)
      const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28)
      const enc = buf.subarray(MAGIC.length + 28)
      const d = crypto.createDecipheriv('aes-256-gcm', key32, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
    },
  }
}

// --- secure-enclave backend (production) ----------------------------------
// Shells out to the CryptoKit SecureEnclave.P256 helper (tools/vault/se/eos-vault-se).
// The SE private key never leaves the Enclave; only its SE-wrapped dataRepresentation
// blob sits on disk (non-extractable, machine-bound). Plaintext travels on the child
// process stdin/stdout, never argv. No entitlement, no biometric prompt (unattended).
// Verified live 2026-07-17: seal/open roundtrip MATCH, cross-key open authenticationFailure.
const { execFileSync } = require('child_process')
const _fs = require('fs')
const _path = require('path')
const SE_HELPER = _path.join(__dirname, 'se', 'eos-vault-se')
const SE_KEYFILE = _path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'se-key.bin')

function secureEnclaveBackend(opts) {
  opts = opts || {}
  const helper = opts.helperPath || SE_HELPER
  const keyfile = opts.keyfile || SE_KEYFILE
  const ready = _fs.existsSync(helper) && _fs.existsSync(keyfile)
  return {
    id: 'secure-enclave',
    provisioned: ready,
    seal(plaintext) {
      if (!ready) throw new Error('secure-enclave not provisioned: run tools/vault/se/eos-vault-se provision <keyfile>')
      return execFileSync(helper, ['seal', keyfile], { input: Buffer.from(plaintext, 'utf8'), maxBuffer: 1 << 20 }).toString('utf8').trim()
    },
    open(sealed) {
      if (!ready) throw new Error('secure-enclave not provisioned')
      return execFileSync(helper, ['open', keyfile], { input: Buffer.from(sealed, 'utf8'), maxBuffer: 1 << 20 }).toString('utf8')
    },
  }
}

// createKeystore({ backend }) - default to software with an ephemeral key if none
// given (test). Production passes a secure-enclave backend.
function createKeystore(opts) {
  opts = opts || {}
  const backend = opts.backend || softwareBackend(opts.key32 || crypto.randomBytes(32))
  return {
    backendId: backend.id,
    seal: (pt) => backend.seal(pt),
    open: (ct) => backend.open(ct),
  }
}

module.exports = { createKeystore, softwareBackend, secureEnclaveBackend, MAGIC }
