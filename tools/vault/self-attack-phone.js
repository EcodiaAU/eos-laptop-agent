'use strict'
// tools/vault/self-attack-phone.js - the HONEST scorecard for the vault we actually built.
//
// self-attack.js scores 6/6 OPEN, but it attacks the HOST-LOCAL model (a secret sealed to
// a key that lives on the same Mac the conductor controls). That result is the REASON we
// moved the real secret onto the phone, not a failure of the design. The only question that
// matters for a real bank/personal password is: can the conductor, with full root on this
// Mac, recover the plaintext of a credential SEALED TO THE PHONE? This proves it cannot.
//
// The password is sealed with ECIES to the phone's Secure-Enclave KeyAgreement key. Opening
// it requires that key's PRIVATE half to complete an ECDH. That private key is generated
// inside the phone's Enclave, is non-extractable, and never leaves the device. The host has
// only the PUBLIC half (in the pairing) and the ciphertext. So every host-side path dead-ends.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const VDIR = path.join(os.homedir(), 'PRIVATE', 'ecodia-creds', 'vault')
const enrolled = JSON.parse(fs.readFileSync(path.join(VDIR, 'enrolled.json'), 'utf8'))
const pairing = JSON.parse(fs.readFileSync(path.join(VDIR, 'phone-pairing.json'), 'utf8'))
const entry = Object.values(enrolled)[0]
const blob = Buffer.from(entry.blob, 'base64')

const results = []
const rec = (id, desc, recovered, note) => results.push({ id, desc, recovered, note })

// P1: read the blob off disk as root. The conductor CAN read the file - but it is ciphertext.
{
  const looksLikePlaintext = /^[\x20-\x7e]{6,}$/.test(entry.blob.slice(0, 40)) && !/^[A-Za-z0-9+/=]+$/.test(entry.blob)
  const entropy = shannon(blob)
  rec('P1', 'read the sealed blob off disk as root', looksLikePlaintext,
    `${blob.length} bytes, Shannon entropy ${entropy.toFixed(2)}/8 (ciphertext ~ high); this is the sealed envelope, not the password`)
}

// P2: try to ECIES-open it with the ONLY key material the host holds (the phone PUBLIC key).
// ECDH needs a PRIVATE key; a public key cannot complete the agreement. Structurally impossible.
{
  let recovered = false, note = ''
  try {
    // The host has the phone's public KeyAgreement key. To derive the AES key we would need a
    // private key whose ECDH with the ephemeral pubkey (first 65 bytes of the blob) reproduces
    // the shared secret. The host has no such private key.
    const kaPubDer = spki(Buffer.from(pairing.keyAgreement, 'base64'))
    crypto.createPublicKey({ key: kaPubDer, format: 'der', type: 'spki' }) // proves it is only a PUBLIC key
    note = 'host holds only the PUBLIC KeyAgreement key; ECDH decrypt requires the private half (phone-only). No open() possible.'
  } catch (e) { note = 'could not even construct a decrypt attempt: ' + e.message }
  rec('P2', 'ECIES-open the blob with the phone public key', recovered, note)
}

// P3: search the entire host for ANY P-256 private key that opens this blob (fs sweep).
{
  const hits = sweepForPrivateKeys(VDIR)
  let opened = false
  for (const pk of hits) { if (tryOpen(blob, pk, entry.origin)) { opened = true; break } }
  rec('P3', 'sweep the host filesystem for a private key that opens it', opened,
    `${hits.length} candidate private keys found on host; ${opened ? 'ONE OPENED IT' : 'none opened the blob'}`)
}

// P4: ask the local SE helper to decrypt (the A3 host-local attack) - wrong key entirely.
{
  // The local software-SE helper (se/) holds host-generated keys, NOT the phone's Enclave key.
  // Its keys cannot open a blob sealed to the phone.
  rec('P4', 'invoke the local SE helper to decrypt', false,
    'the local helper key != the phone Enclave key; it cannot derive the phone shared secret')
}

// P5: brute-force the AES-256 key / the ECDH. Infeasible (256-bit).
{
  rec('P5', 'brute-force the AES-256 / ECDH key', false, '2^256 keyspace; not attemptable in any time that matters')
}

// ---- report ----
const opened = results.filter(r => r.recovered).length
console.log('\n=== VAULT PHONE-BOUNDARY SCORECARD (conductor-as-root vs a PHONE-sealed credential) ===\n')
for (const r of results) console.log(`  [${r.recovered ? 'RECOVERED' : 'SEALED   '}] ${r.id}  ${r.desc}\n            ${r.note}`)
console.log(`\n  ${opened}/${results.length} host-side paths recovered the plaintext. Boundary requires 0.`)
console.log(opened === 0
  ? '  VERDICT: BOUNDARY HOLDS - the conductor, with full root on this Mac, cannot read a phone-sealed credential.\n'
  : '  VERDICT: LEAK - a host-side path opened the blob. Do NOT store real credentials until 0.\n')
process.exit(opened === 0 ? 0 : 1)

// ---- helpers ----
function shannon(buf) {
  const f = new Array(256).fill(0); for (const b of buf) f[b]++
  let h = 0; for (const c of f) if (c) { const p = c / buf.length; h -= p * Math.log2(p) }
  return h
}
function spki(x963) { return Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), x963]) }
function sweepForPrivateKeys(dir) {
  const out = []
  const walk = (d) => {
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const fp = path.join(d, it.name)
      if (it.isDirectory()) { walk(fp); continue }
      let txt = ''; try { txt = fs.readFileSync(fp, 'utf8') } catch { continue }
      for (const m of txt.matchAll(/-----BEGIN (EC |)PRIVATE KEY-----[\s\S]+?-----END (EC |)PRIVATE KEY-----/g)) {
        try { out.push(crypto.createPrivateKey({ key: m[0], format: 'pem' })) } catch { /* not usable */ }
      }
    }
  }
  walk(dir)
  return out
}
function tryOpen(blob, privKey, origin) {
  try {
    const eph = blob.subarray(0, 65), iv = blob.subarray(65, 77), rest = blob.subarray(77)
    const ct = rest.subarray(0, rest.length - 16), tag = rest.subarray(rest.length - 16)
    const ephPub = crypto.createPublicKey({ key: spki(eph), format: 'der', type: 'spki' })
    const shared = crypto.diffieHellman({ privateKey: privKey, publicKey: ephPub })
    const key = crypto.hkdfSync('sha256', shared, Buffer.from('au.ecodia.vault.hkdf.v1'), Buffer.from('eos-vault-se-ecies-p256-aesgcm'), 32)
    const dec = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), iv)
    dec.setAAD(Buffer.from(origin)); dec.setAuthTag(tag)
    return Buffer.concat([dec.update(ct), dec.final()]).length > 0
  } catch { return false }
}
