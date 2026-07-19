'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { submit2fa } = require('./submit-2fa')

const ROWS = [
  { seed_id: 's1', service: 'github', tier: 'OPEN', backend: 'totp', registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' },
  { seed_id: 's3', service: 'google-tate', tier: 'GATED', backend: 'totp', registered_origin: 'https://accounts.google.com', registered_account: 'tate@ecodia.au' },
]
const SEED = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'sha1', digits: 6, period: 30 }

function baseDeps(overrides) {
  const filled = []
  const events = []
  const deps = {
    rows: ROWS,
    loadSeed: async () => SEED,
    verifyTab: async () => true,
    fill: async (ref, code) => { filled.push(code); return { ok: true } },
    audit: (e) => events.push(e),
    now: () => 59,
    _filled: filled, _events: events,
  }
  return Object.assign(deps, overrides)
}

test('OPEN TOTP: fills the code and returns status only (never the code)', async () => {
  const deps = baseDeps()
  const res = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, deps)
  assert.strictEqual(res.status, 'filled')
  assert.strictEqual(res.code, undefined)          // the code NEVER crosses back
  assert.strictEqual(deps._filled.length, 1)       // it was filled into the tab
  assert.match(deps._filled[0], /^\d{6}$/)
})

test('GATED without approval token: returns approval_required, does NOT fill', async () => {
  let opened = null
  const deps = baseDeps({ approvals: { validate: () => false, open: (svc, summary) => { opened = summary; return 'chal-1' } } })
  const res = await submit2fa({ service: 'google-tate', cdpSessionRef: 'tab1' }, deps)
  assert.strictEqual(res.status, 'approval_required')
  assert.strictEqual(res.challenge_id, 'chal-1')
  assert.strictEqual(deps._filled.length, 0)       // nothing filled without approval
  assert.match(opened, /tate@ecodia.au/)
})

test('GATED with valid approval token: fills', async () => {
  const deps = baseDeps({ approvals: { validate: () => true, open: () => 'x' } })
  const res = await submit2fa({ service: 'google-tate', cdpSessionRef: 'tab1', approvalToken: 'nonce-ok' }, deps)
  assert.strictEqual(res.status, 'filled')
  assert.strictEqual(deps._filled.length, 1)
})

test('unknown service: default-DENY, no seed load, no fill', async () => {
  let loaded = false
  const deps = baseDeps({ loadSeed: async () => { loaded = true; return SEED } })
  const res = await submit2fa({ service: 'dropbox', cdpSessionRef: 'tab1' }, deps)
  assert.strictEqual(res.status, 'denied')
  assert.strictEqual(res.reason, 'no-match-default-deny')
  assert.strictEqual(loaded, false)
  assert.strictEqual(deps._filled.length, 0)
})

test('tab origin/account mismatch: denied, no fill (T4 tenant confusion)', async () => {
  const deps = baseDeps({ verifyTab: async () => false })
  const res = await submit2fa({ service: 'github', cdpSessionRef: 'wrong-tab' }, deps)
  assert.strictEqual(res.status, 'denied')
  assert.strictEqual(res.reason, 'tab-mismatch')
  assert.strictEqual(deps._filled.length, 0)
})

test('budget freeze: denied before any secret is touched', async () => {
  let loaded = false
  const deps = baseDeps({
    loadSeed: async () => { loaded = true; return SEED },
    budget: { allow: () => ({ ok: false, reason: 'frozen' }), recordResolve() {}, freeze() {} },
  })
  const res = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, deps)
  assert.strictEqual(res.status, 'denied')
  assert.strictEqual(res.reason, 'budget-frozen')
  assert.strictEqual(loaded, false)                // fail-closed BEFORE seed touch
})

test('missing seed: denied cleanly', async () => {
  const deps = baseDeps({ loadSeed: async () => null })
  const res = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, deps)
  assert.strictEqual(res.status, 'denied')
  assert.strictEqual(res.reason, 'seed-missing')
})

test('generated code matches the RFC vector for this seed+time (fill is real)', async () => {
  const deps = baseDeps()
  await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, deps)
  // seed GEZD... at t=59, 6-digit sha1 -> last 6 of RFC vector 94287082 = 287082
  assert.strictEqual(deps._filled[0], '287082')
})
