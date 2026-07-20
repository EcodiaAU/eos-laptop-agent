'use strict'
// tools/vault/vault-pull.js - the Mac conductor end of the phone->host relay. Reads
// unconsumed rows from public.vault_inbox (written by the vault-ingest edge function),
// AUTHORITATIVELY verifies each Secure Enclave signature here on the Mac against the
// paired key (the relay is not trusted; the signature is), applies verified bank results
// to the persisted ledger, and marks every row consumed. An unsigned or bad-signature
// row is consumed as rejected (garbage-collected), never acted on.
//
//   node vault-pull.js            pull + apply once
// Env overrides (for tests, so the real pairing/ledger are never touched):
//   VAULT_PAIRING=<path>   pairing json (default ~/PRIVATE/ecodia-creds/vault/phone-pairing.json)
//   VAULT_LEDGER=<path>    ledger json  (default ~/PRIVATE/ecodia-creds/vault/bank-ledger.json)
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spkiFromX963, canonical, valueBound } = require('./inbox.js')
const { createLedger } = require('./bank-ledger.js')

const VDIR = path.join(os.homedir(), 'PRIVATE', 'ecodia-creds', 'vault')
const PAIRING = process.env.VAULT_PAIRING || path.join(VDIR, 'phone-pairing.json')
const LEDGER = process.env.VAULT_LEDGER || path.join(VDIR, 'bank-ledger.json')

function loadJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (_e) { return dflt } }
function saveJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(o, null, 2), { mode: 0o600 }) }

// Authoritative verify: does this message carry a valid signature from the paired phone?
function verify(msg) {
  const pairing = loadJson(PAIRING, null)
  if (!pairing || !pairing.signing || !msg.sig) return false
  try {
    const key = crypto.createPublicKey({ key: spkiFromX963(Buffer.from(pairing.signing, 'base64')), format: 'der', type: 'spki' })
    const sigOk = crypto.verify(null, canonical(msg), { key, dsaEncoding: 'der' }, Buffer.from(msg.sig, 'base64'))
    return sigOk && valueBound(msg)   // a swapped value (hash mismatch) fails even with a valid sig
  } catch (_e) { return false }
}

// App Attest ENFORCEMENT: the paired signing key is only trusted if Apple attested it is a
// genuine Secure-Enclave key on a real device running our app. Without this, a software
// impostor key paired through a compromised step would pass signature verification. The bind
// requires a vault_attested_keys row whose bound_signing_x963 equals the paired signing key
// (i.e. the App Attest ceremony committed to THIS exact key), with a real App Attest aaguid.
async function pairedKeyIsAttested(db) {
  const pairing = loadJson(PAIRING, null)
  if (!pairing || !pairing.signing) return false
  if (process.env.VAULT_SKIP_ATTEST === '1') return true   // tests inject their own pairing
  try {
    const r = await db`SELECT 1 FROM public.vault_attested_keys
                       WHERE bound_signing_x963 = ${pairing.signing} AND aaguid IN ('appattest', 'appattestdevelop') LIMIT 1`
    return r.length > 0
  } catch (_e) { return false }
}

// Apply a verified bank-statement result to the persisted ledger.
function applyBankResult(msg) {
  const state = loadJson(LEDGER, { startingBalance: 0, transactions: [] })
  const L = createLedger({ startingBalance: state.startingBalance, transactions: state.transactions })
  const applied = L.applyScrape(Array.isArray(msg.transactions) ? msg.transactions : [])
  const snap = L.snapshot()
  saveJson(LEDGER, { startingBalance: snap.startingBalance, transactions: snap.transactions, updatedAt: new Date().toISOString() })
  const rec = msg.balance != null ? L.reconcile(msg.balance) : null
  return { added: applied.added, skipped: applied.skipped, runningBalance: applied.runningBalance, reconcile: rec }
}

async function pull(db) {
  const rows = await db`SELECT id, type, payload FROM public.vault_inbox WHERE consumed_at IS NULL ORDER BY created_at`
  const out = []
  // App Attest is a PRECONDITION for trusting any signed result: the paired key must be proven
  // genuine Secure-Enclave hardware. Computed once per pull. (enroll + attest rows are exempt -
  // attest is how a key BECOMES trusted; enroll is ciphertext the host cannot use anyway.)
  const attested = await pairedKeyIsAttested(db)
  for (const row of rows) {
    const msg = row.payload || {}
    // Enroll rows carry a sealed credential blob (ciphertext only the phone can open); they
    // are not signed. Store the blob via the enroll store, then consume.
    if (row.type === 'enroll') {
      let r = { id: row.id, type: 'enroll' }
      try {
        const { store } = require('./enroll.js')
        r.stored = store(JSON.stringify({ ...msg, type: 'enroll' }))
        r.action = 'enrolled'
      } catch (e) { r.action = 'enroll-failed'; r.error = e.message }
      await db`UPDATE public.vault_inbox SET consumed_at = now(), note = ${r.action} WHERE id = ${row.id}`
      out.push(r); continue
    }
    // App Attest rows carry their own Apple attestation (not our result signature); verify
    // the attestation and record the attested key, then consume.
    if (row.type === 'attest') {
      let r = { id: row.id, type: 'attest' }
      try {
        const { verifyAttestation } = require('./vault-attest.js')
        r.attest = await verifyAttestation(db, { keyId: msg.keyId, attestation: msg.attestation, challenge: msg.challenge, bindPubX963: msg.bindPubX963 })
        r.action = 'attested'
      } catch (e) { r.action = 'attestation-rejected'; r.error = e.message }
      await db`UPDATE public.vault_inbox SET consumed_at = now(), sig_verified = ${r.action === 'attested'}, note = ${r.action} WHERE id = ${row.id}`
      out.push(r); continue
    }
    const sigOk = verify(msg)
    const ok = sigOk && attested   // trusted only if the signature is valid AND the key is attested hardware
    let result = { id: row.id, type: row.type, sigVerified: sigOk, attested }
    if (!sigOk) {
      result.action = 'rejected (bad or missing signature)'
    } else if (!attested) {
      result.action = 'rejected (paired key not App-Attested genuine hardware)'
    } else if (row.type === 'result' && (msg.kind === 'bank-statement' || msg.service === 'bank')) {
      result.action = 'applied-to-ledger'
      result.ledger = applyBankResult(msg)
    } else {
      result.action = 'stored'
    }
    // If this verified result answers a pending approval, mark it approved (arms the WAKE
    // that re-opens the conductor with the task continuation - so an approval that lands
    // hours later resumes the task instead of it dying while I was asleep).
    if (ok && msg.requestId) {
      try {
        const { approve } = require('./vault-approval.js')
        result.approval = await approve(db, msg.requestId, msg.approvedBy || 'tate')
      } catch (e) { result.approvalError = e.message }
    }
    await db`UPDATE public.vault_inbox SET consumed_at = now(), sig_verified = ${ok}, note = ${result.action} WHERE id = ${row.id}`
    out.push(result)
  }
  return out
}

module.exports = { pull, verify, applyBankResult, pairedKeyIsAttested }

if (require.main === module) {
  const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')
  const db = lib.db()
  pull(db).then(out => { console.log(JSON.stringify({ pulled: out.length, results: out }, null, 2)); process.exit(0) })
    .catch(e => { console.error('ERR', e.message); process.exit(1) })
}
