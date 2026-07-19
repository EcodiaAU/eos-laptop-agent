'use strict'
// SE-MODE E2E (live, not a unit test): runs the whole vault daemon on the REAL
// Secure Enclave key. Enrolls a seed (SE-sealed at rest), then submit_2fa opens it
// via the Enclave and fills the RFC-correct code. Proves the production at-rest root
// works end to end. Run: node tools/vault/se-mode-e2e.js
const assert = require('node:assert')
const { createKeystore, secureEnclaveBackend } = require('./keystore')
const { createSeedStore } = require('./seed-store')
const { createDaemon } = require('./vault-daemon')
const { createBudget } = require('./budget')

const se = secureEnclaveBackend({})
assert.strictEqual(se.provisioned, true, 'SE key must be provisioned (run eos-vault-se provision first)')

const ks = createKeystore({ backend: se })
assert.strictEqual(ks.backendId, 'secure-enclave')

// direct seal/open through the Enclave
const probe = ks.open(ks.seal('GEZDGNBVGY3TQOJQ'))
assert.strictEqual(probe, 'GEZDGNBVGY3TQOJQ', 'SE seal/open roundtrip')

// full daemon on the SE-backed store
const store = createSeedStore({ keystore: ks })   // in-memory sqlite, SE-sealed secrets
const filled = []
const d = createDaemon({
  store,
  budget: createBudget({ now: () => 59 }),
  verifyTab: async () => true,
  fill: async (ref, code) => { filled.push(code); return { ok: true } },
  now: () => 59,
})

const OTPAUTH = 'otpauth://totp/GitHub:code@ecodia.au?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub&digits=6&period=30'
const seedId = store.enroll({ service: 'github', tier: 'OPEN', backend: 'totp', otpauthUri: OTPAUTH, registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' })

// prove the secret at rest is SE ciphertext, not plaintext
const rawBlob = store._db.prepare('SELECT seed_ciphertext FROM vault_seed WHERE seed_id=?').get(seedId)
const blobStr = Buffer.from(rawBlob.seed_ciphertext).toString('utf8')
assert.ok(!blobStr.includes('GEZDGNBVGY3TQOJQ'), 'at-rest blob must NOT contain plaintext')

;(async () => {
  const server = d.listen(0)
  await new Promise(r => server.once('listening', r))
  try {
    const { port } = server.address()
    const http = require('node:http')
    const post = (path, body) => new Promise((resolve) => {
      const data = JSON.stringify(body)
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))) })
      r.write(data); r.end()
    })
    const res = await post('/submit_2fa', { service: 'github', cdp_session_ref: 'tab1' })
    assert.strictEqual(res.status, 'filled', 'submit_2fa must fill')
    assert.strictEqual(res.code, undefined, 'code must never cross HTTP')
    assert.strictEqual(filled[0], '287082', 'SE-opened seed must generate the RFC vector code')
    console.log('SE-MODE E2E PASS:')
    console.log('  backend           =', ks.backendId)
    console.log('  at-rest blob       = SE ciphertext (no plaintext)  [' + blobStr.length + ' b64 chars]')
    console.log('  submit_2fa status  =', res.status, '(code never returned)')
    console.log('  filled code        =', filled[0], '(RFC 6238 vector, seed opened by the Enclave)')
    console.log('  => the daemon runs on the real Secure Enclave root of trust.')
  } finally { server.close(); store.close() }
})().catch(e => { console.error('SE-MODE E2E FAIL:', e.message); process.exit(1) })
