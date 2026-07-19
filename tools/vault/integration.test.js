'use strict'
// Integration: the REAL budget module composed into submit_2fa via its injected
// interface. Proves the safety rail actually fires through the primitive, not just
// in isolation.
const test = require('node:test')
const assert = require('node:assert')
const { submit2fa } = require('./submit-2fa')
const { createBudget } = require('./budget')

const ROWS = [{ seed_id: 's1', service: 'github', tier: 'OPEN', backend: 'totp', registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' }]
const SEED = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'sha1', digits: 6, period: 30 }

function deps(budget) {
  return {
    rows: ROWS,
    loadSeed: async () => SEED,
    verifyTab: async () => true,
    fill: async () => ({ ok: true }),
    budget,
    now: () => 59,
    audit: () => {},
  }
}

test('real budget freezes submit_2fa after a burst, fail-closed', async () => {
  const frozen = []
  const budget = createBudget({ config: { perServiceMax: 3 }, now: () => 1000, onFreeze: (s, r) => frozen.push([s, r]) })
  const d = deps(budget)
  // 3 successful fills
  for (let i = 0; i < 3; i++) {
    const r = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, d)
    assert.strictEqual(r.status, 'filled')
  }
  // 4th exceeds the per-service budget -> denied, and the service is now frozen
  const over = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, d)
  assert.strictEqual(over.status, 'denied')
  assert.match(over.reason, /budget-/)
  assert.strictEqual(budget.isFrozen('github'), true)
  assert.strictEqual(frozen.length, 1)
  // subsequent attempts stay denied (fail-closed) until a manual clear
  const stillDenied = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, d)
  assert.strictEqual(stillDenied.status, 'denied')
})

test('single-flight: a second concurrent resolve is refused while one is in flight', async () => {
  const budget = createBudget({ now: () => 1000 })
  // simulate: allow() taken but recordResolve not yet called (in-flight)
  assert.strictEqual(budget.allow('github').ok, true)
  const d = deps(budget)
  const r = await submit2fa({ service: 'github', cdpSessionRef: 'tab1' }, d)
  assert.strictEqual(r.status, 'denied')
  assert.strictEqual(r.reason, 'budget-in-flight')
})
