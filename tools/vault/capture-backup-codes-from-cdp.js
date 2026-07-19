'use strict'
// tools/vault/capture-backup-codes-from-cdp.js - DAEMON-SIDE recovery-code capture.
// Recovery codes are DURABLE secrets (valid until used), so they must never reach
// the conductor. This process reads them from the live DOM, seals each into the
// Secure Enclave via the vault keystore, and prints ONLY the count + a set
// fingerprint. Pairs with backup-codes.js (two-phase lease/confirm) at use time.
// Usage: node capture-backup-codes-from-cdp.js <service> <urlSubstr>
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const WebSocket = require(path.join('/Users/ecodia/.code/ecodiaos/backend', 'node_modules', 'ws'))
const { createKeystore, secureEnclaveBackend } = require('./keystore')
const { createSeedStore } = require('./seed-store')
const { resolveService } = require('./registry')

const SERVICE = process.argv[2] || 'github'
const URLSUB = process.argv[3] || 'github.com/settings/two_factor'
const PORT = process.env.CDP_PORT || '9222'
const VAULT_DB = path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'vault.db')

function httpJson(p) {
  return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej) })
}

// Recovery-code shapes. Learned live 2026-07-17: GitHub issues SIXTEEN codes of
// ten alphanumeric chars with NO hyphen, and renders them in textContent (an
// innerText scan misses them). The discriminator that separates a code from an
// ordinary word is that it contains BOTH a letter and a digit - a plain-word run
// like "aaaaaaaaaa" never does. Hyphenated shapes are kept for other vendors.
const EXTRACT = `(() => {
  const tc = (document.body && document.body.textContent) || '';
  const set = new Set();
  // hyphenated vendors first (5-5, 4-4-4)
  for (const m of tc.matchAll(/\\b([a-z0-9]{5}-[a-z0-9]{5})\\b/gi)) set.add(m[1].toLowerCase());
  for (const m of tc.matchAll(/\\b([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\\b/gi)) set.add(m[1].toLowerCase());
  if (set.size >= 5) return [...set];
  // GitHub: 10 chars, must mix letters AND digits
  for (const m of tc.matchAll(/\\b[a-z0-9]{10}\\b/gi)) {
    const c = m[0].toLowerCase();
    if (/[0-9]/.test(c) && /[a-z]/.test(c)) set.add(c);
  }
  return [...set];
})()`

async function main() {
  const se = secureEnclaveBackend({})
  if (!se.provisioned) throw new Error('Secure Enclave key not provisioned')
  const ks = createKeystore({ backend: se })
  const store = createSeedStore({ keystore: ks, dbPath: VAULT_DB })
  const list = await httpJson('/json/list')
  const page = list.find(t => t.type === 'page' && (t.url || '').includes(URLSUB) && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no CDP page matching ' + URLSUB)
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  let id = 0; const pending = {}
  const send = (m, p) => new Promise((res, rej) => { const mid = ++id; pending[mid] = { res, rej }; ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending[d.id]) { d.error ? pending[d.id].rej(new Error(d.error.message)) : pending[d.id].res(d.result); delete pending[d.id] } })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await send('Runtime.enable', {})
  try {
    const r = await send('Runtime.evaluate', { expression: EXTRACT, returnByValue: true })
    const codes = r.result.value || []
    if (!codes.length) throw new Error('no recovery codes found in the DOM')
    const resolved = resolveService(SERVICE, store.loadRegistry())
    if (!resolved.ok) throw new Error('service not enrolled: ' + resolved.reason)
    store.addBackupCodes(resolved.seed_id, codes)
    const setFp = crypto.createHash('sha256').update(codes.slice().sort().join('|')).digest('hex').slice(0, 8)
    store.audit({ service: SERVICE, backend: 'backup_code', event: 'enroll', detail: `captured ${codes.length} recovery codes, SE-sealed` })
    console.log(JSON.stringify({ service: SERVICE, seed_id: resolved.seed_id, codesCaptured: codes.length, setFingerprint: setFp, sealed: true }))
  } finally { ws.close(); store.close() }
}

main().catch(e => { console.log(JSON.stringify({ error: e.message })); process.exit(1) })
