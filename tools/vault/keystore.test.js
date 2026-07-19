'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const { createKeystore, softwareBackend, secureEnclaveBackend } = require('./keystore')
const { submit2fa } = require('./submit-2fa')

test('software seal/open round-trips a secret', () => {
  const ks = createKeystore({ key32: crypto.randomBytes(32) })
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  const sealed = ks.seal(secret)
  assert.notStrictEqual(sealed, secret)         // ciphertext, not plaintext
  assert.strictEqual(ks.open(sealed), secret)   // exact round-trip
})

test('ciphertext is opaque base64 and contains no plaintext', () => {
  const ks = createKeystore({ key32: crypto.randomBytes(32) })
  const sealed = ks.seal('GEZDGNBVGY3TQOJQ')
  assert.doesNotMatch(sealed, /GEZDGNBVGY3TQOJQ/)
})

test('tampered ciphertext fails the GCM auth tag (integrity)', () => {
  const ks = createKeystore({ key32: crypto.randomBytes(32) })
  const sealed = ks.seal('secret-seed')
  const buf = Buffer.from(sealed, 'base64'); buf[buf.length - 1] ^= 0xff   // flip a byte
  assert.throws(() => ks.open(buf.toString('base64')))
})

test('wrong key cannot open', () => {
  const a = createKeystore({ key32: crypto.randomBytes(32) })
  const b = createKeystore({ key32: crypto.randomBytes(32) })
  const sealed = a.seal('x')
  assert.throws(() => b.open(sealed))
})

test('secure-enclave backend fails safe when the key/helper is absent', () => {
  const se = secureEnclaveBackend({ helperPath: '/nonexistent/helper', keyfile: '/nonexistent/key.bin' })
  assert.strictEqual(se.provisioned, false)
  assert.throws(() => se.seal('x'), /not provisioned/)
})

test('secure-enclave backend round-trips through the real Enclave when provisioned', () => {
  const se = secureEnclaveBackend({})   // default paths = the real provisioned key on this Mac
  if (!se.provisioned) { return }        // skip on a machine without the provisioned SE key
  assert.strictEqual(se.open(se.seal('GEZDGNBVGY3TQOJQ')), 'GEZDGNBVGY3TQOJQ')
})

// --- FULL SOFTWARE-MODE E2E: encrypted seed -> submit_2fa decrypts + fills ---
test('E2E: sealed seed at rest -> submit_2fa opens it, generates, fills (code never returned)', async () => {
  const ks = createKeystore({ key32: crypto.randomBytes(32) })
  // "enrollment": seal the otpauth secret at rest, keyed by seed_id
  const sealedSeed = ks.seal('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  const store = { s1: { sealed: sealedSeed, algorithm: 'sha1', digits: 6, period: 30 } }

  const filled = []
  const deps = {
    rows: [{ seed_id: 's1', service: 'github', tier: 'OPEN', backend: 'totp', registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' }],
    // loadSeed OPENS the sealed blob inside the daemon; plaintext never leaves here
    loadSeed: async (seed_id) => {
      const row = store[seed_id]
      if (!row) return null
      return { secret: ks.open(row.sealed), algorithm: row.algorithm, digits: row.digits, period: row.period }
    },
    verifyTab: async () => true,
    fill: async (ref, code) => { filled.push(code); return { ok: true } },
    now: () => 59,
    audit: () => {},
  }
  const res = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, deps)
  assert.strictEqual(res.status, 'filled')
  assert.strictEqual(res.code, undefined)          // never returned
  assert.strictEqual(filled[0], '287082')          // RFC vector for this seed @ t=59, 6-digit
})
