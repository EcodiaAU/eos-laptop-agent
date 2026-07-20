'use strict'
// Proves replay-freshness: a stale signed result (old ts) is rejected, and an exact re-post of
// a signature that was already consumed is rejected as a replay. VAULT_SKIP_ATTEST focuses this
// on the freshness/replay gate (attestation is covered by its own test). Cleans up.
process.env.VAULT_SKIP_ATTEST = '1'
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultreplay-'))
process.env.VAULT_PAIRING = path.join(tmp, 'pairing.json')
process.env.VAULT_LEDGER = path.join(tmp, 'ledger.json')
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const x963 = publicKey.export({ type: 'spki', format: 'der' }).slice(-65)
fs.writeFileSync(process.env.VAULT_PAIRING, JSON.stringify({ keyAgreement: x963.toString('base64'), signing: x963.toString('base64') }))
fs.writeFileSync(process.env.VAULT_LEDGER, JSON.stringify({ startingBalance: 0, transactions: [] }))

const { pull, isFresh } = require('./vault-pull.js')
const { canonical } = require('./inbox.js')
const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')
const db = lib.db()
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
function signed(msg) { return { ...msg, sig: crypto.sign(null, canonical(msg), { key: privateKey, dsaEncoding: 'der' }).toString('base64') } }

;(async () => {
  const ids = []
  try {
    // unit: isFresh
    assert.strictEqual(isFresh({ ts: new Date().toISOString() }), true, 'now is fresh')
    assert.strictEqual(isFresh({ ts: new Date(Date.now() - 20 * 60000).toISOString() }), false, '20min old is stale')
    assert.strictEqual(isFresh({ ts: new Date(Date.now() + 20 * 60000).toISOString() }), false, 'future-dated is rejected')
    assert.strictEqual(isFresh({}), true, 'ts-less skips freshness')

    // 1. STALE: a validly-signed result with an old (signed) ts is rejected.
    const stale = signed({ type: 'result', service: 'x', value: '1', valueSha256: sha('1'), ts: new Date(Date.now() - 30 * 60000).toISOString() })
    let r = await db`INSERT INTO public.vault_inbox (type, payload) VALUES ('result', ${db.json(stale)}) RETURNING id`; ids.push(r[0].id)
    let out = (await pull(db)).filter(o => o.id === r[0].id)
    assert.strictEqual(out[0].sigVerified, true, 'stale result signature is valid')
    assert.match(out[0].action, /stale/, 'but rejected as stale')

    // 2. REPLAY: a fresh result stores; re-posting the SAME signed bytes is rejected.
    const good = signed({ type: 'result', service: 'x', value: '2', valueSha256: sha('2'), ts: new Date().toISOString() })
    r = await db`INSERT INTO public.vault_inbox (type, payload) VALUES ('result', ${db.json(good)}) RETURNING id`; ids.push(r[0].id)
    out = (await pull(db)).filter(o => o.id === r[0].id)
    assert.strictEqual(out[0].action, 'stored', 'first post of a fresh result is trusted')
    // re-post the identical signed message (new row, same signature)
    r = await db`INSERT INTO public.vault_inbox (type, payload) VALUES ('result', ${db.json(good)}) RETURNING id`; ids.push(r[0].id)
    out = (await pull(db)).filter(o => o.id === r[0].id)
    assert.match(out[0].action, /replay/, 'the exact re-post is rejected as a replay')

    console.log('vault-replay: 8/8 - stale rejected, future rejected, ts-less allowed, replay of a consumed signature rejected')
  } finally {
    for (const id of ids) await db`DELETE FROM public.vault_inbox WHERE id = ${id}`
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
