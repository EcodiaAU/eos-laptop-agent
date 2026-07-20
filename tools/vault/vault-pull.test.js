'use strict'
// E2E against the REAL substrate vault_inbox table, but with a throwaway pairing + ledger
// (env overrides) so the real ones are never touched. Inserts rows the way the edge
// function would, runs the puller, asserts verify+apply+reject, then deletes the test rows.
process.env.VAULT_SKIP_ATTEST = '1'
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpull-'))
process.env.VAULT_PAIRING = path.join(tmp, 'pairing.json')
process.env.VAULT_LEDGER = path.join(tmp, 'ledger.json')

// throwaway phone signing key (we hold the private key only here)
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const x963 = publicKey.export({ type: 'spki', format: 'der' }).slice(-65)
fs.writeFileSync(process.env.VAULT_PAIRING, JSON.stringify({ keyAgreement: x963.toString('base64'), signing: x963.toString('base64') }))
// seed the ledger with a known starting balance
fs.writeFileSync(process.env.VAULT_LEDGER, JSON.stringify({ startingBalance: 1000.00, transactions: [] }))

const { pull } = require('./vault-pull.js')
const { canonical } = require('./inbox.js')
const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')
const db = lib.db()

function signed(msg) {
  const sig = crypto.sign(null, canonical(msg), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
  return { ...msg, sig }
}

;(async () => {
  const ids = []
  try {
    // 1. A genuine signed bank statement (what the phone would post after a login+scrape).
    const stmt = signed({
      type: 'result', service: 'bank', kind: 'bank-statement',
      transactions: [
        { date: '2026-07-18', description: 'Coles', amount: -42.10 },
        { date: '2026-07-18', description: 'Salary', amount: 2500.00 },
      ],
      balance: '3457.90', ts: '2026-07-19',
    })
    let r = await db`INSERT INTO public.vault_inbox (type, payload) VALUES ('result', ${db.json(stmt)}) RETURNING id`
    ids.push(r[0].id)

    // 2. An UNSIGNED row (a spammer with the ingest secret but no SE key). Must be rejected.
    r = await db`INSERT INTO public.vault_inbox (type, payload) VALUES ('result', ${db.json({ type: 'result', service: 'bank', kind: 'bank-statement', transactions: [{ date: '2026-07-19', description: 'FAKE', amount: -999.00 }], balance: '0' })}) RETURNING id`
    ids.push(r[0].id)

    const out = await pull(db)
    const mine = out.filter(o => ids.includes(o.id))
    assert.strictEqual(mine.length, 2, 'pulled both test rows')

    const applied = mine.find(o => o.action === 'applied-to-ledger')
    assert.ok(applied, 'the signed statement was applied to the ledger')
    assert.strictEqual(applied.sigVerified, true, 'signature verified on the Mac')
    assert.strictEqual(applied.ledger.added, 2, 'both transactions added')
    assert.strictEqual(applied.ledger.runningBalance, 3457.90, 'balance carried: 1000 + 2500 - 42.10')
    assert.strictEqual(applied.ledger.reconcile.match, true, 'carried balance matches the scraped balance')

    const rejected = mine.find(o => o.sigVerified === false)
    assert.ok(rejected, 'the unsigned spam row was rejected')
    assert.strictEqual(rejected.action, 'rejected (bad or missing signature)', 'spam never touched the ledger')

    // re-pull: both are consumed now, nothing to do (idempotent).
    const again = (await pull(db)).filter(o => ids.includes(o.id))
    assert.strictEqual(again.length, 0, 're-pull consumes nothing (rows marked consumed)')

    console.log('vault-pull E2E: 7/7 - signed statement verified+applied+reconciled on the Mac, spam rejected, consume idempotent')
  } finally {
    for (const id of ids) await db`DELETE FROM public.vault_inbox WHERE id = ${id}`
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
