'use strict'
// Proves App Attest is ENFORCED: a validly-signed result from a paired key that has NOT passed
// App Attest is rejected; once that key is bound in vault_attested_keys, the same result is
// trusted. NO VAULT_SKIP_ATTEST here - this test exercises the real gate. Cleans up after.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultattest-'))
process.env.VAULT_PAIRING = path.join(tmp, 'pairing.json')
process.env.VAULT_LEDGER = path.join(tmp, 'ledger.json')

// throwaway phone signing key (we hold the private key)
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const x963 = publicKey.export({ type: 'spki', format: 'der' }).slice(-65)
const x963b64 = x963.toString('base64')
fs.writeFileSync(process.env.VAULT_PAIRING, JSON.stringify({ keyAgreement: x963b64, signing: x963b64 }))
fs.writeFileSync(process.env.VAULT_LEDGER, JSON.stringify({ startingBalance: 0, transactions: [] }))

const { pull, pairedKeyIsAttested } = require('./vault-pull.js')
const { canonical } = require('./inbox.js')
const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')
const db = lib.db()

function signed(msg) {
  return { ...msg, sig: crypto.sign(null, canonical(msg), { key: privateKey, dsaEncoding: 'der' }).toString('base64') }
}

;(async () => {
  const ids = []
  const testKeyId = 'enforce-test-' + crypto.randomBytes(6).toString('hex')
  try {
    // 1. paired key is NOT attested yet.
    assert.strictEqual(await pairedKeyIsAttested(db), false, 'a freshly-paired key is not attested')

    // 2. a validly-signed result from the non-attested key must be REJECTED.
    const m1 = signed({ type: 'result', service: 'x', field: 'v', value: '10', valueSha256: crypto.createHash('sha256').update('10').digest('hex'), ts: 't1' })
    let r = await db`INSERT INTO public.vault_inbox (type, payload) VALUES ('result', ${db.json(m1)}) RETURNING id`; ids.push(r[0].id)
    let out = (await pull(db)).filter(o => o.id === r[0].id)
    assert.strictEqual(out[0].sigVerified, true, 'signature itself is valid')
    assert.strictEqual(out[0].attested, false, 'but the key is not attested')
    assert.match(out[0].action, /not App-Attested/, 'result REJECTED because the key is not attested hardware')

    // 3. bind the key as attested (as a real App Attest ceremony would).
    await db`INSERT INTO public.vault_attested_keys (key_id, pub_x963, bound_signing_x963, aaguid) VALUES (${testKeyId}, ${x963b64}, ${x963b64}, 'appattest')`
    assert.strictEqual(await pairedKeyIsAttested(db), true, 'the key is now attested')

    // 4. the same shape of signed result is now TRUSTED.
    const m2 = signed({ type: 'result', service: 'x', field: 'v', value: '20', valueSha256: crypto.createHash('sha256').update('20').digest('hex'), ts: 't2' })
    r = await db`INSERT INTO public.vault_inbox (type, payload) VALUES ('result', ${db.json(m2)}) RETURNING id`; ids.push(r[0].id)
    out = (await pull(db)).filter(o => o.id === r[0].id)
    assert.strictEqual(out[0].attested, true, 'key attested')
    assert.strictEqual(out[0].action, 'stored', 'result now TRUSTED (stored), not rejected')

    console.log('vault-attest-enforce: 6/6 - non-attested key REJECTED, attested key TRUSTED (App Attest is now a precondition)')
  } finally {
    for (const id of ids) await db`DELETE FROM public.vault_inbox WHERE id = ${id}`
    await db`DELETE FROM public.vault_attested_keys WHERE key_id = ${testKeyId}`
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
