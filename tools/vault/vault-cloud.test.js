'use strict'
// LIVE cloud E2E: posts through the deployed vault-ingest edge function, then pulls +
// applies on the Mac. Throwaway pairing/ledger so nothing real is touched; cleans up its
// row. Reads the ingest secret from disk at runtime (never embeds/prints it).
process.env.VAULT_SKIP_ATTEST = '1'
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')

const FN_URL = 'https://nxmtfzofemtrlezlyhcj.supabase.co/functions/v1/vault-ingest'
const SECRET = fs.readFileSync(path.join(os.homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'ingest-secret.txt'), 'utf8').trim()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultcloud-'))
process.env.VAULT_PAIRING = path.join(tmp, 'pairing.json')
process.env.VAULT_LEDGER = path.join(tmp, 'ledger.json')
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const x963 = publicKey.export({ type: 'spki', format: 'der' }).slice(-65)
fs.writeFileSync(process.env.VAULT_PAIRING, JSON.stringify({ keyAgreement: x963.toString('base64'), signing: x963.toString('base64') }))
fs.writeFileSync(process.env.VAULT_LEDGER, JSON.stringify({ startingBalance: 500.00, transactions: [] }))

const { pull } = require('./vault-pull.js')
const { canonical } = require('./inbox.js')
const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')
const db = lib.db()

function postFn(secret, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj)
    const u = new URL(FN_URL)
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-vault-ingest': secret } }, (res) => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(raw) } catch { return raw } })() }))
    })
    req.on('error', reject); req.write(data); req.end()
  })
}

function signed(msg) {
  return { ...msg, sig: crypto.sign(null, canonical(msg), { key: privateKey, dsaEncoding: 'der' }).toString('base64') }
}

;(async () => {
  let insertedId = null
  try {
    // 1. Wrong secret -> the function rejects at the door (401), no row.
    let r = await postFn('wrong-secret', { type: 'result', payload: { x: 1 } })
    assert.strictEqual(r.status, 401, 'wrong ingest secret rejected 401')

    // 2. Real secret + a genuine phone-signed bank statement -> 200 + id.
    const stmt = signed({ type: 'result', service: 'bank', kind: 'bank-statement', transactions: [{ date: '2026-07-19', description: 'Woolworths', amount: -63.40 }], balance: '436.60', ts: new Date().toISOString() })
    r = await postFn(SECRET, { type: 'result', payload: stmt })
    assert.strictEqual(r.status, 200, 'signed statement accepted by the live function')
    assert.ok(r.json.id, 'function returned a row id')
    insertedId = r.json.id

    // 3. Pull on the Mac -> verify + apply the row that came through the cloud.
    const out = (await pull(db)).filter(o => o.id === insertedId)
    assert.strictEqual(out.length, 1, 'the cloud-delivered row was pulled')
    assert.strictEqual(out[0].sigVerified, true, 'signature verified on the Mac')
    assert.strictEqual(out[0].action, 'applied-to-ledger', 'applied to the ledger')
    assert.strictEqual(out[0].ledger.added, 1, 'the transaction was added')
    assert.strictEqual(out[0].ledger.runningBalance, 436.60, '500 - 63.40 carried')
    assert.strictEqual(out[0].ledger.reconcile.match, true, 'reconciles with the scraped balance')

    console.log('vault-cloud E2E: 8/8 - wrong-secret 401, live function 200, Mac pulled+verified+applied+reconciled through the real cloud path')
  } finally {
    if (insertedId) await db`DELETE FROM public.vault_inbox WHERE id = ${insertedId}`
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
