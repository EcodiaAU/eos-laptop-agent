'use strict'
// Security-negative + structural tests for the App Attest verifier. The POSITIVE path needs
// a real Apple attestation from a device (like the login loop, device-gated), so here we
// prove the verifier REJECTS everything that is not a genuine, fresh, our-app attestation.
const assert = require('assert')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cbor = require('cbor')
const attest = require('./vault-attest.js')
const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')
const db = lib.db()

// A self-signed (non-Apple) P-256 cert, via openssl, to prove chain verification rejects it.
function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attcert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=not-apple'], { stdio: 'ignore' })
  const pem = fs.readFileSync(path.join(dir, 'c.pem'))
  const der = new crypto.X509Certificate(pem).raw
  fs.rmSync(dir, { recursive: true, force: true })
  return der
}

;(async () => {
  const cleanup = []
  try {
    // 1. issueChallenge stores a fresh 32-byte challenge.
    const ch = await attest.issueChallenge(db)
    cleanup.push(ch)
    assert.strictEqual(Buffer.from(ch, 'base64').length, 32, 'challenge is 32 bytes')
    const stored = await db`SELECT used_at FROM public.vault_attest_challenges WHERE challenge = ${ch}`
    assert.ok(stored.length === 1 && !stored[0].used_at, 'challenge stored, unused')

    // 2. unknown challenge is rejected.
    await assert.rejects(attest.verifyAttestation(db, { keyId: 'x', attestation: '', challenge: 'never-issued' }), /unknown challenge/, 'unknown challenge rejected')

    // 3. wrong fmt is rejected (well-formed CBOR, not apple-appattest).
    const bogus = cbor.encode({ fmt: 'not-apple', authData: Buffer.alloc(37), attStmt: { x5c: [] } }).toString('base64')
    await assert.rejects(attest.verifyAttestation(db, { keyId: 'x', attestation: bogus, challenge: ch }), /not apple-appattest/, 'non-apple fmt rejected')

    // 4. a non-Apple cert chain is rejected by verifyChain (the core trust anchor).
    const fake = selfSignedCert()
    assert.throws(() => attest.verifyChain([fake, fake]), /not signed by Apple App Attest Root CA|not signed by intermediate/, 'a self-signed non-Apple chain is rejected')

    // 5. nonceFromCert on a cert with NO App Attest extension throws (no false-positive nonce).
    const root = new crypto.X509Certificate(fs.readFileSync(path.join(__dirname, 'attest', 'apple-appattest-root.pem')))
    assert.throws(() => attest.nonceFromCert(root), /extension OID not found/, 'no nonce is invented when the extension is absent')

    // 6. replay: mark the challenge used, verify a second use is rejected.
    await db`UPDATE public.vault_attest_challenges SET used_at = now() WHERE challenge = ${ch}`
    await assert.rejects(attest.verifyAttestation(db, { keyId: 'x', attestation: bogus, challenge: ch }), /already used/, 'used challenge (replay) rejected')

    // 7. RP ID formula is our app.
    assert.strictEqual(attest.APP_ID, '86PUY7393S.au.ecodia.friend', 'RP ID binds our team + bundle')

    console.log('vault-attest: 8/8 - fresh challenge, unknown/replay/wrong-fmt/non-apple-chain/absent-nonce all rejected; app id bound')
  } finally {
    for (const ch of cleanup) await db`DELETE FROM public.vault_attest_challenges WHERE challenge = ${ch}`
  }
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
