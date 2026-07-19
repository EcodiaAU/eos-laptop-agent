'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createBudget } = require('./budget')

function clock(start) { let t = start; return { now: () => t, tick: (s) => { t += s } } }

test('allows under budget, holds single-flight until recordResolve', () => {
  const b = createBudget({ now: () => 1000 })
  assert.strictEqual(b.allow('github').ok, true)
  // second allow while first in-flight is refused
  assert.strictEqual(b.allow('github').reason, 'in-flight')
  b.recordResolve('github')
  assert.strictEqual(b.allow('github').ok, true)   // lock released
})

test('per-service burst auto-freezes fail-closed', () => {
  const b = createBudget({ config: { perServiceMax: 3 }, now: () => 1000 })
  for (let i = 0; i < 3; i++) { assert.strictEqual(b.allow('github').ok, true); b.recordResolve('github') }
  const r = b.allow('github')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'per-service-budget')
  assert.strictEqual(b.isFrozen('github'), true)
  // stays frozen even after another allow attempt
  assert.match(b.allow('github').reason, /^frozen:/)
})

test('global cap freezes across services', () => {
  const b = createBudget({ config: { perServiceMax: 100, globalMax: 2 }, now: () => 1000 })
  b.allow('a'); b.recordResolve('a')
  b.allow('b'); b.recordResolve('b')
  const r = b.allow('c')
  assert.strictEqual(r.reason, 'global-budget')
})

test('consecutive failures trip the circuit breaker', () => {
  const b = createBudget({ config: { maxConsecutiveFails: 2 }, now: () => 1000 })
  b.allow('vercel'); b.recordFailure('vercel')
  b.allow('vercel'); b.recordFailure('vercel')
  assert.strictEqual(b.isFrozen('vercel'), true)
})

test('a success resets the consecutive-fail counter before the breaker trips', () => {
  const b = createBudget({ config: { maxConsecutiveFails: 3 }, now: () => 1000 })
  b.allow('xero'); b.recordFailure('xero')
  b.recordSuccess('xero')
  b.allow('xero'); b.recordFailure('xero')
  b.allow('xero'); b.recordFailure('xero')
  assert.strictEqual(b.isFrozen('xero'), false)   // never hit 3 in a row
})

test('window rolls over and resets the per-service count', () => {
  const c = clock(1000)
  const b = createBudget({ config: { perServiceMax: 2, windowSeconds: 100 }, now: c.now })
  b.allow('stripe'); b.recordResolve('stripe')
  b.allow('stripe'); b.recordResolve('stripe')
  c.tick(101)   // window elapsed
  assert.strictEqual(b.allow('stripe').ok, true)   // count reset, not frozen
})

test('onFreeze hook fires exactly once at freeze', () => {
  const frozen = []
  const b = createBudget({ config: { perServiceMax: 1 }, now: () => 1000, onFreeze: (s, r) => frozen.push([s, r]) })
  b.allow('canva'); b.recordResolve('canva')
  b.allow('canva')   // exceeds -> freeze
  assert.strictEqual(frozen.length, 1)
  assert.strictEqual(frozen[0][0], 'canva')
})

test('clearFreeze is manual and un-freezes', () => {
  const b = createBudget({ config: { perServiceMax: 1 }, now: () => 1000 })
  b.allow('bitbucket'); b.recordResolve('bitbucket'); b.allow('bitbucket')
  assert.strictEqual(b.isFrozen('bitbucket'), true)
  b.clearFreeze('bitbucket')
  assert.strictEqual(b.isFrozen('bitbucket'), false)
  assert.strictEqual(b.allow('bitbucket').ok, true)
})
