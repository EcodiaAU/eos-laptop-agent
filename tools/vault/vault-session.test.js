// Tests for vault-session.js - the host side of SESSION TRANSFER.
// Proves: recipient private key is actually persisted (the bug that shipped),
// the phone->host ECIES cookie round-trip, origin AAD binding, flag-preserving
// cookie mapping, and the inject sequence against a fake CDP. No phone/Chrome needed.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// Redirect the recipient file to a scratch path so the test never touches the real
// key. We reload the module after setting HOME so RECIP_FILE resolves to scratch.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-session-'))
const realHome = os.homedir
os.homedir = () => scratch
delete require.cache[require.resolve('./vault-session.js')]
const S = require('./vault-session.js')
const { sealTo } = require('./envelope.js')

let pass = 0, fail = 0
const queue = []
function t(name, fn) { queue.push({ name, fn }) }

const ORIGIN = 'https://accounts.google.com/'
const COOKIES = [
  { name: '__Secure-1PSID', value: 'SEKRET1', domain: '.google.com', path: '/', httpOnly: true, secure: true, sameSite: 'None', expires: 1893456000 },
  { name: 'SID', value: 'SEKRET2', domain: '.google.com', path: '/', httpOnly: false, secure: false },
  { name: 'SSID', value: 'SEKRET3', domain: '.google.com', path: '/', httpOnly: true, secure: true },
]

// 1. genRecipient persists a USABLE private key (the exact bug: ecdh:{} lost it).
t('genRecipient persists a private key that loadRecipient can rebuild', () => {
  const pub = S.genRecipient()
  assert(pub.publicX963B64 && pub.publicX963B64.length === 88, 'pubkey x963 should be 65 bytes b64')
  const raw = JSON.parse(fs.readFileSync(S.RECIP_FILE, 'utf8'))
  assert(raw.privB64 && raw.privB64.length > 20, 'private key must be persisted as base64, not lost')
  const r = S.loadRecipient()
  assert(r.ecdh && typeof r.ecdh.computeSecret === 'function', 'loadRecipient rebuilds a usable ECDH')
  assert.strictEqual(r.publicX963B64, pub.publicX963B64)
})

// 2. Regression guard: a file with an empty ecdh (the shipped bug) must be rejected.
t('loadRecipient rejects the unserialisable-ecdh file (regression guard)', () => {
  const bad = { ecdh: {}, publicX963B64: 'x', publicRawB64: 'y' }
  fs.writeFileSync(S.RECIP_FILE, JSON.stringify(bad))
  assert.throws(() => S.loadRecipient(), /private key missing/)
  S.genRecipient() // restore a good key for the rest
})

// 3. Phone->host ECIES round-trip: seal to the recipient pubkey, openSession opens.
t('openSession opens a bundle the phone sealed to the recipient pubkey', () => {
  const { publicX963B64 } = S.recipientPublic()
  const blob = sealTo(publicX963B64, JSON.stringify(COOKIES), ORIGIN)
  const out = S.openSession({ value: blob, origin: ORIGIN })
  assert.deepStrictEqual(out, COOKIES, 'round-trip must return the exact cookie array')
})

// 4. Origin is bound as AAD: a bundle sealed for accounts.google.com cannot be
//    opened claiming a different origin.
t('openSession throws when the origin AAD does not match the sealed origin', () => {
  const { publicX963B64 } = S.recipientPublic()
  const blob = sealTo(publicX963B64, JSON.stringify(COOKIES), ORIGIN)
  assert.throws(() => S.openSession({ value: blob, origin: 'https://evil.example/' }))
})

// 5. Flag-preserving cookie mapping - httpOnly/secure/sameSite/expires must carry.
t('toSetCookieOpts preserves httpOnly/secure/sameSite/expires and merges target', () => {
  const o = S.toSetCookieOpts(COOKIES[0], { urlContains: 'google.com' })
  assert.strictEqual(o.name, '__Secure-1PSID')
  assert.strictEqual(o.httpOnly, true)
  assert.strictEqual(o.secure, true)
  assert.strictEqual(o.sameSite, 'None')
  assert.strictEqual(o.expires, 1893456000)
  assert.strictEqual(o.urlContains, 'google.com')
  // A non-httpOnly/non-secure cookie must NOT carry those flags.
  const o2 = S.toSetCookieOpts(COOKIES[1], {})
  assert.strictEqual(o2.httpOnly, undefined)
  assert.strictEqual(o2.secure, undefined)
})

// 6. Inject sequence against a fake CDP: setCookie called per cookie, flags intact,
//    navigate + runJs invoked for the verify probe.
t('injectToChrome sets every cookie with flags intact and probes login', async () => {
  const calls = { setCookie: [], navigate: [], runJs: 0 }
  const fakeCdp = {
    setCookie: async (o) => { calls.setCookie.push(o); return { ok: true } },
    navigate: async (o) => { calls.navigate.push(o.url); return { ok: true } },
    runJs: async () => { calls.runJs++; return { result: { signIn: false, hasAccount: true } } },
  }
  const r = await S.injectToChrome(COOKIES, { cdp: fakeCdp })
  assert.strictEqual(r.count, 3, 'all three cookies set')
  assert.deepStrictEqual(r.failed, [])
  const psid = calls.setCookie.find(c => c.name === '__Secure-1PSID')
  assert(psid.httpOnly && psid.secure, 'HttpOnly+Secure preserved into cdp.setCookie')
  assert(calls.navigate.length >= 1, 'navigated to establish/verify the origin')
  assert.strictEqual(calls.runJs, 1, 'ran the login-probe JS')
  assert(r.verified && r.verified.hasAccount === true, 'surfaced the login signal')
})

// 7. applySession is the full open+inject path behind a passed trust gate.
t('applySession opens the sealed bundle and injects', async () => {
  const { publicX963B64 } = S.recipientPublic()
  const blob = sealTo(publicX963B64, JSON.stringify(COOKIES), ORIGIN)
  const fakeCdp = { setCookie: async () => ({ ok: true }), navigate: async () => ({}), runJs: async () => ({ result: { signIn: false, hasAccount: true } }) }
  const r = await S.applySession({ value: blob, origin: ORIGIN }, { cdp: fakeCdp })
  assert.strictEqual(r.cookies, 3)
  assert.strictEqual(r.inject.count, 3)
})

;(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ok  ' + name); pass++ }
    catch (e) { console.log('FAIL  ' + name + ' :: ' + e.message); fail++ }
  }
  os.homedir = realHome
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch (_e) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
