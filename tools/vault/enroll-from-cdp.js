'use strict'
// tools/vault/enroll-from-cdp.js - DAEMON-SIDE seed capture (red-team T1 seed-birth).
// The conductor never sees the seed at its birth: this process reads the vendor's
// setup key straight from the live CDP DOM, seals it into the Secure Enclave, and
// fills the confirmation code itself. It prints ONLY {seed_id, status} - never the
// seed, never the code. Design: docs/security/2fa-...md s10 (daemon-side capture).
//
// Usage: node enroll-from-cdp.js <service> <tier> <urlSubstr> <otpInputSelector> [confirmBtnRegex]
const path = require('path')
const http = require('http')
const WebSocket = require(path.join('/Users/ecodia/.code/ecodiaos/backend', 'node_modules', 'ws'))
const { createKeystore, secureEnclaveBackend } = require('./keystore')
const { createSeedStore } = require('./seed-store')
const totp = require('./totp')

const SERVICE = process.argv[2] || 'github'
const TIER = process.argv[3] || 'OPEN'
const URLSUB = process.argv[4] || 'github.com/settings/two_factor'
const OTP_SEL = process.argv[5] || '#otp'
const PORT = process.env.CDP_PORT || '9222'
const VAULT_DB = path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'vault.db')

function httpJson(p) {
  return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej) })
}

async function connect() {
  const list = await httpJson('/json/list')
  const page = list.find(t => t.type === 'page' && (t.url || '').includes(URLSUB) && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no CDP page matching ' + URLSUB)
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  let id = 0; const pending = {}
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending[mid] = { res, rej }; ws.send(JSON.stringify({ id: mid, method, params })) })
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending[d.id]) { d.error ? pending[d.id].rej(new Error(d.error.message)) : pending[d.id].res(d.result); delete pending[d.id] } })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await send('Runtime.enable', {})
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || ''))
    return r.result.value
  }
  return { evaluate, close: () => ws.close(), url: page.url }
}

// Extract the base32 setup key (or an otpauth:// URI) from the live DOM.
// Runs IN the page and returns the secret to THIS process only.
//
// PRECISION MATTERS (learned live 2026-07-17): a naive /^[A-Z2-7]{16,64}$/ over
// element text matches ORDINARY WORDS - the heading "Setup authenticator app"
// compacts to SETUPAUTHENTICATORAPP, which is all A-Z and passed the test, so the
// first run sealed a tooltip instead of the key and GitHub rejected the code. Two
// guards now: (1) prefer the vendor's exact phrasing, (2) require at least one
// base32 DIGIT (2-7), which every real TOTP secret has and English words never do.
const EXTRACT = `(() => {
  const html = document.documentElement.innerHTML;
  const uri = (html.match(/otpauth:\\/\\/[^"'\\s<>]+/) || [])[0];
  if (uri) return { kind: 'otpauth', value: uri };
  const body = (document.body && document.body.innerText) || '';
  const isRealSecret = (s) => /^[A-Z2-7]{16,64}$/.test(s) && /[2-7]/.test(s);
  // 1. vendor-specific phrasing (GitHub: "Your two-factor secret XXXX to manually ...")
  const phrased = body.match(/two-factor secret\\s+([A-Z2-7\\s]{16,80}?)\\s+to manually/i);
  if (phrased) { const c = phrased[1].replace(/\\s+/g,'').toUpperCase(); if (isRealSecret(c)) return { kind: 'base32', value: c }; }
  // 2. clipboard/value attributes commonly used for copy-the-key buttons
  for (const e of document.querySelectorAll('[data-clipboard-text],input[value]')) {
    const c = (e.getAttribute('data-clipboard-text') || e.getAttribute('value') || '').replace(/\\s+/g,'').toUpperCase();
    if (isRealSecret(c)) return { kind: 'base32', value: c };
  }
  // 3. dedicated element text, digit-guarded
  const texts = [...document.querySelectorAll('code,kbd,pre,span,div,p')].map(e => (e.innerText||'').trim()).filter(t => t && t.length < 120);
  for (const t of texts) {
    const compact = t.replace(/\\s+/g, '').toUpperCase();
    if (isRealSecret(compact)) return { kind: 'base32', value: compact };
  }
  return { kind: 'none' };
})()`

async function main() {
  const se = secureEnclaveBackend({})
  if (!se.provisioned) throw new Error('Secure Enclave key not provisioned')
  const ks = createKeystore({ backend: se })
  const store = createSeedStore({ keystore: ks, dbPath: VAULT_DB })
  const page = await connect()
  try {
    // 1. reveal the setup key if it is behind a toggle
    await page.evaluate(`(() => { const el=[...document.querySelectorAll('button,summary,a')].find(e=>/setup key|can't scan|unable to scan|enter this/i.test(e.innerText||'')); if(el) el.click(); return true })()`)
    await new Promise(r => setTimeout(r, 1200))
    let got = await page.evaluate(EXTRACT)
    if (got.kind === 'none') { await new Promise(r => setTimeout(r, 1500)); got = await page.evaluate(EXTRACT) }
    if (got.kind === 'none') throw new Error('no otpauth URI or base32 setup key found in the DOM')

    // 2. seal into the Enclave + persist. The secret exists only in THIS process.
    // Fingerprint (sha256/8) lets the operator confirm a seed ROTATED without ever
    // seeing its value - needed after a seed is burned by transcript exposure.
    const fingerprint = require('crypto').createHash('sha256').update(got.value).digest('hex').slice(0, 8)
    const enrollArgs = { service: SERVICE, tier: TIER, backend: 'totp', registered_origin: new URL(page.url).origin, enrolled_under_presence: true }
    if (got.kind === 'otpauth') enrollArgs.otpauthUri = got.value
    else enrollArgs.secret = got.value
    const seed_id = store.enroll(enrollArgs)

    // 3. generate the confirmation code + fill it (never returned)
    const seed = store.loadSeed(seed_id)
    const code = totp.totp(seed.secret, { algorithm: seed.algorithm, digits: seed.digits, step: seed.period })
    const fill = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(OTP_SEL)}) || document.querySelector('[name=otp]');
      if (!el) return { ok:false, error:'otp input not found' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      el.focus(); setter.call(el, ${JSON.stringify(code)});
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return { ok:true, filledLength: el.value.length };
    })()`)
    store.audit({ service: SERVICE, tier: TIER, backend: 'totp', event: 'enroll', detail: 'daemon-side capture, SE-sealed' })
    console.log(JSON.stringify({ seed_id, seedKind: got.kind, seedLength_REDACTED: got.value.length, seedFingerprint: fingerprint, fill, db: VAULT_DB }))
  } finally { page.close(); store.close() }
}

main().catch(e => { console.log(JSON.stringify({ error: e.message })); process.exit(1) })
