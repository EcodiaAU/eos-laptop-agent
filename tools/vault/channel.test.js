'use strict'
// Run under a throwaway HOME so it exercises the REAL channel/inbox/enroll code paths
// without touching the real pairing or stores. Proves: signed result -> 200 verified,
// tampered result -> 401, enroll blob -> stored.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const vaultDir = path.join(os.homedir(), 'PRIVATE', 'ecodia-creds', 'vault')
fs.mkdirSync(vaultDir, { recursive: true })

// Stand in for the phone's SE signing key (we hold the private key only in this test).
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const x963 = publicKey.export({ type: 'spki', format: 'der' }).slice(-65)
// Pair this test key as the phone's signing key + a dummy keyagreement key.
fs.writeFileSync(path.join(vaultDir, 'phone-pairing.json'), JSON.stringify({ keyAgreement: x963.toString('base64'), signing: x963.toString('base64') }))

const channel = require('./channel.js')
const { canonical } = require('./inbox.js')

function post(port, pathname, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body)
    const req = require('http').request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }))
    })
    req.write(data); req.end()
  })
}

(async () => {
  const srv = channel.serve(8791)
  await new Promise(r => setTimeout(r, 150))

  // 1. A genuine phone-signed result: the phone scraped the balance and signed it.
  const msg = { type: 'result', service: 'bank', field: 'balance', value: '4231.07', ts: '2026-07-19' }
  const sig = crypto.sign(null, canonical(msg), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
  let r = await post(8791, '/vault/result', { ...msg, sig })
  assert.strictEqual(r.status, 200, 'signed result accepted')
  assert.strictEqual(r.json.sigVerified, true, 'signature verified by paired phone')

  // 2. A tampered result (value changed, old signature) must be rejected.
  r = await post(8791, '/vault/result', { ...msg, value: '999999.00', sig })
  assert.strictEqual(r.status, 401, 'tampered result rejected')

  // 3. An enrollment blob stores (ciphertext only; host cannot open it).
  r = await post(8791, '/vault/enroll', { service: 'demo', origin: 'https://x.test', username: 'u', blob: 'AAAA' })
  assert.strictEqual(r.status, 200, 'enroll stored')
  assert.ok(r.json.note.includes('cannot open'), 'host holds ciphertext only')

  // 4. Unknown path 404.
  r = await post(8791, '/vault/nope', {})
  assert.strictEqual(r.status, 404, 'unknown path rejected')

  srv.close()
  console.log('channel: 6/6 - signed result 200+verified, tampered 401, enroll stored, unknown 404')
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
