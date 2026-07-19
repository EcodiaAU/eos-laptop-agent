'use strict'
// tools/vault/vault-attest.js - Apple App Attest verification. Proves the phone's key is
// genuinely Secure-Enclave-backed, on a real Apple device, running OUR real app (bundle
// au.ecodia.friend) - not a software impostor paired during a compromised step. This gates
// enrollment of any REAL credential: we only trust a signing key that came with a valid
// Apple attestation.
//
// Verification follows Apple's "Validating Apps That Connect to Your Server":
//   1. decode the CBOR attestation object {fmt, attStmt:{x5c}, authData}
//   2. verify the x5c cert chain credCert -> intermediate -> Apple App Attest Root CA
//   3. nonce = sha256(authData || sha256(challenge)) must equal the nonce in credCert's
//      extension OID 1.2.840.113635.100.8.2 (binds THIS challenge to THIS attestation)
//   4. sha256(credCert public key, x9.62 uncompressed) must equal the claimed keyId
//   5. authData RP ID hash must equal sha256("<teamId>.<bundleId>") (binds OUR app)
// The challenge is server-issued and single-use, so an attestation cannot be replayed.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const cbor = require('cbor')
const { X509Certificate } = crypto

const TEAM_ID = '86PUY7393S'
const BUNDLE_ID = 'au.ecodia.friend'
const APP_ID = `${TEAM_ID}.${BUNDLE_ID}`
const ROOT_PEM = fs.readFileSync(path.join(__dirname, 'attest', 'apple-appattest-root.pem'))
const APPATTEST_OID_BYTES = Buffer.from('06092a864886f76364080204', 'hex') // OID 1.2.840.113635.100.8.2 + OCTET STRING tag

const sha256 = (b) => crypto.createHash('sha256').update(b).digest()

// Server-issued single-use challenge.
async function issueChallenge(db, purpose = 'attest') {
  const challenge = crypto.randomBytes(32).toString('base64')
  await db`INSERT INTO public.vault_attest_challenges (challenge, purpose) VALUES (${challenge}, ${purpose})`
  return challenge
}

// The attested public key as x9.62 uncompressed (0x04||X||Y), base64 - matches the phone
// signing key we verify results against.
function pubX963FromCert(cert) {
  const der = cert.publicKey.export({ type: 'spki', format: 'der' })
  return der.subarray(der.length - 65) // last 65 bytes of a P-256 SPKI = uncompressed point
}

// Pull the 32-byte nonce out of credCert's App Attest extension. The extension value is an
// OCTET STRING wrapping SEQUENCE { [1] OCTET STRING(32) }; we locate the OID then take the
// 32-byte octet string that follows.
function nonceFromCert(cert) {
  const der = Buffer.from(cert.raw)
  const at = der.indexOf(APPATTEST_OID_BYTES)
  if (at < 0) throw new Error('App Attest extension OID not found in credCert')
  const marker = Buffer.from('0420', 'hex') // OCTET STRING, length 32
  const m = der.indexOf(marker, at)
  if (m < 0) throw new Error('nonce octet string not found')
  return der.subarray(m + 2, m + 2 + 32)
}

function verifyChain(x5c) {
  if (!Array.isArray(x5c) || x5c.length < 2) throw new Error('x5c must have credCert + intermediate')
  const credCert = new X509Certificate(x5c[0])
  const interCert = new X509Certificate(x5c[1])
  const root = new X509Certificate(ROOT_PEM)
  const now = new Date()
  for (const [c, name] of [[credCert, 'credCert'], [interCert, 'intermediate']]) {
    if (new Date(c.validFrom) > now || new Date(c.validTo) < now) throw new Error(name + ' outside validity window')
  }
  if (!credCert.verify(interCert.publicKey)) throw new Error('credCert not signed by intermediate')
  if (!interCert.verify(root.publicKey)) throw new Error('intermediate not signed by Apple App Attest Root CA')
  return credCert
}

// verifyAttestation(db, {keyId, attestation, challenge, bindPubX963}) -> {ok, keyId, pubKeyX963}.
// bindPubX963 (base64) is the phone's Secure Enclave SIGNING key that our result signatures
// use. The phone folds it into the attested client data, so a valid attestation proves that
// signing key is co-resident in the genuine app on genuine hardware - not just some DCAppAttest
// key. The host confirms it equals the paired signing key.
async function verifyAttestation(db, { keyId, attestation, challenge, bindPubX963 }) {
  // challenge must be one we issued and not yet used
  const rows = await db`SELECT id, used_at FROM public.vault_attest_challenges WHERE challenge = ${challenge}`
  if (!rows.length) throw new Error('unknown challenge (not issued by us)')
  if (rows[0].used_at) throw new Error('challenge already used (replay)')

  const obj = cbor.decodeFirstSync(Buffer.from(attestation, 'base64'))
  if (obj.fmt !== 'apple-appattest') throw new Error('fmt is not apple-appattest')
  const authData = Buffer.from(obj.authData)
  const credCert = verifyChain(obj.attStmt.x5c)

  // nonce binding. clientData = challenge || the bound signing pubkey (if given), so the
  // attestation commits to our signing key too.
  const bindBytes = bindPubX963 ? Buffer.from(bindPubX963, 'base64') : Buffer.alloc(0)
  const clientDataHash = sha256(Buffer.concat([Buffer.from(challenge, 'base64'), bindBytes]))
  const expectedNonce = sha256(Buffer.concat([authData, clientDataHash]))
  const certNonce = nonceFromCert(credCert)
  if (!crypto.timingSafeEqual(expectedNonce, certNonce)) throw new Error('nonce mismatch (challenge not bound to attestation)')

  // keyId = sha256(attested public key)
  const pub = pubX963FromCert(credCert)
  const computedKeyId = sha256(pub).toString('base64')
  if (computedKeyId !== keyId) throw new Error('keyId does not match the attested public key')

  // RP ID hash binds OUR app
  const rpIdHash = authData.subarray(0, 32)
  if (!crypto.timingSafeEqual(rpIdHash, sha256(Buffer.from(APP_ID)))) throw new Error('RP ID hash != sha256(app id) - not our app')

  // aaguid must be an App Attest environment
  const aaguid = authData.subarray(37, 53).toString('latin1').replace(/\0+$/, '')
  if (aaguid !== 'appattest' && aaguid !== 'appattestdevelop') throw new Error('unexpected aaguid: ' + aaguid)

  // If a signing key was bound, it must equal the phone's paired signing key - so the key we
  // verify results against is the one just proven to be genuine hardware.
  let boundSigningVerified = null
  if (bindPubX963) {
    const pairing = (() => { try { return JSON.parse(fs.readFileSync(path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'phone-pairing.json'), 'utf8')) } catch { return null } })()
    boundSigningVerified = !!(pairing && pairing.signing === bindPubX963)
    if (pairing && pairing.signing && !boundSigningVerified) throw new Error('bound signing key != paired signing key')
  }

  await db`UPDATE public.vault_attest_challenges SET used_at = now() WHERE id = ${rows[0].id}`
  await db`INSERT INTO public.vault_attested_keys (key_id, pub_x963, aaguid, bound_signing_x963) VALUES (${keyId}, ${pub.toString('base64')}, ${aaguid}, ${bindPubX963 || null})
           ON CONFLICT (key_id) DO UPDATE SET pub_x963 = EXCLUDED.pub_x963, bound_signing_x963 = EXCLUDED.bound_signing_x963, verified_at = now()`
  return { ok: true, keyId, pubKeyX963: pub.toString('base64'), aaguid, env: aaguid, boundSigningVerified }
}

module.exports = { issueChallenge, verifyAttestation, verifyChain, nonceFromCert, pubX963FromCert, sha256, APP_ID }
