'use strict'
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const crypto = require('crypto')
const { createDaemon } = require('./vault-daemon')
const { createSeedStore } = require('./seed-store')
const { createKeystore } = require('./keystore')
const { createBudget } = require('./budget')

const OTPAUTH = 'otpauth://totp/GitHub:code@ecodia.au?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub&digits=6&period=30'

function req(server, method, path, body) {
  const { port } = server.address()
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }))
    })
    if (data) r.write(data); r.end()
  })
}

function makeDaemon(overrides) {
  const store = createSeedStore({ keystore: createKeystore({ key32: crypto.randomBytes(32) }) })
  const filled = []
  const d = createDaemon(Object.assign({
    store,
    budget: createBudget({ now: () => 59 }),
    verifyTab: async () => true,
    fill: async (ref, code) => { filled.push(code); return { ok: true } },
    now: () => 59,
  }, overrides))
  return { d, store, filled }
}

test('E2E over real HTTP: enroll then submit_2fa fills, response is status-only', async () => {
  const { d, filled } = makeDaemon()
  const server = d.listen(0)
  await new Promise(r => server.once('listening', r))
  try {
    const enroll = await req(server, 'POST', '/enroll', { service: 'github', tier: 'OPEN', backend: 'totp', otpauthUri: OTPAUTH, registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' })
    assert.strictEqual(enroll.status, 200)
    assert.ok(enroll.json.seed_id)

    const sub = await req(server, 'POST', '/submit_2fa', { service: 'github', cdp_session_ref: 'tab1' })
    assert.strictEqual(sub.status, 200)
    assert.strictEqual(sub.json.status, 'filled')
    assert.strictEqual(sub.json.code, undefined)        // the HTTP body NEVER carries the code
    assert.strictEqual(filled[0], '287082')             // it was filled into the tab (RFC vector)
  } finally { server.close() }
})

test('health endpoint exposes liveness + seed count, no secret', async () => {
  const { d } = makeDaemon()
  const server = d.listen(0); await new Promise(r => server.once('listening', r))
  try {
    const h = await req(server, 'GET', '/health')
    assert.strictEqual(h.json.ok, true)
    assert.strictEqual(typeof h.json.seeds, 'number')
    assert.strictEqual(JSON.stringify(h.json).includes('secret'), false)
  } finally { server.close() }
})

test('fail-safe: with no real verifier/filler wired, submit_2fa DENIES (never blind-fills)', async () => {
  const store = createSeedStore({ keystore: createKeystore({ key32: crypto.randomBytes(32) }) })
  const d = createDaemon({ store, budget: createBudget({ now: () => 59 }), now: () => 59 })  // no fill/verifyTab
  const server = d.listen(0); await new Promise(r => server.once('listening', r))
  try {
    await req(server, 'POST', '/enroll', { service: 'github', tier: 'OPEN', backend: 'totp', otpauthUri: OTPAUTH })
    const sub = await req(server, 'POST', '/submit_2fa', { service: 'github', cdp_session_ref: 'tab1' })
    assert.strictEqual(sub.json.status, 'denied')       // fail-closed, default verifyTab returns false
    assert.strictEqual(sub.json.reason, 'tab-mismatch')
  } finally { server.close() }
})

test('unknown service over HTTP is denied (default-DENY end to end)', async () => {
  const { d } = makeDaemon()
  const server = d.listen(0); await new Promise(r => server.once('listening', r))
  try {
    const sub = await req(server, 'POST', '/submit_2fa', { service: 'dropbox', cdp_session_ref: 'tab1' })
    assert.strictEqual(sub.json.status, 'denied')
    assert.strictEqual(sub.json.reason, 'no-match-default-deny')
  } finally { server.close() }
})

test('server binds loopback only', async () => {
  const { d } = makeDaemon()
  const server = d.listen(0); await new Promise(r => server.once('listening', r))
  try {
    assert.strictEqual(server.address().address, '127.0.0.1')
  } finally { server.close() }
})
